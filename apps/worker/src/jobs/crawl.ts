// Phase 2 §4.1.1 — website crawler + LLM analysis worker.
//
// Strategy (Playwright-rendered):
//   1. BFS-walk pages within the same origin starting at root_url.
//   2. Up to maxPages, up to maxDepth links deep.
//   3. For each page: launch a headless Chromium context, navigate with
//      `waitUntil: 'networkidle'` so React / Vue / Next-rendered SPA
//      content has time to mount, then extract page.content() and feed
//      it to cheerio for prose extraction.
//   4. Persist to crawl_pages.
//   5. Once crawl is done, fan out a single LLM analyze call that turns the
//      cleaned corpus into KnowledgeBaseEntry rows + detected_tone, which
//      we write to BotConfig.
//
// SSRF: we route every fetch through assertSafeOutboundUrl so a tenant
// can't aim the crawler at internal services.
//
// Why Playwright vs the old plain HTTP fetcher: SPAs (most modern
// estate / e-commerce / SaaS marketing sites) return only a minimal HTML
// shell over HTTP — the actual property cards / product cards / FAQs
// don't exist until JavaScript runs in the browser and renders them. The
// HTTP-only crawler captured the shell on every URL (same 277-char skeleton
// across the entire site), which made the KB extraction nearly empty.
import { assertSafeOutboundUrl, UrlGuardError } from '@platform/shared';
import { Worker } from 'bullmq';
import * as cheerio from 'cheerio';
import type { Browser, BrowserContext, Page } from 'playwright';

import { isOpenAIConfigured, workerComplete } from '../lib/openai.js';
import { env } from '../lib/env.js';
import { isWorkerShuttingDown } from '../lib/lifecycle.js';
import { getConnection } from '../lib/redis.js';
import { assertUrlResolvesPublic, safeFetch, type SafeResponse } from '../lib/safe-fetch.js';
import { putObject } from '../lib/storage.js';

import { prisma, withRlsBypass } from './db.js';

interface CrawlPayload {
  organizationId: string;
  crawlJobId: string;
}

// One BFS-fetched page. `images` carries every <img src> we observed
// alongside its alt text so the listing-extraction LLM can pair products
// with their card-level thumbnails on the same prompt that names them.
interface CorpusPage {
  url: string;
  title: string | null;
  text: string;
  images: { url: string; alt: string }[];
}

const MAX_BODY_BYTES = 100_000; // 100 KB per page
// Bumped 15s → 30s on 2026-06-01 after legabarit + several WooCommerce
// sites hit 15s timeouts on their heavier templates (CF + analytics
// + product-grid hydration + ~20 ad pixels). 30s is generous enough
// to absorb cold cache + slow CDN edges; the trade-off is at most
// ~30s wasted per truly-dead page, which BFS just counts as failed
// and moves on from.
const NAV_TIMEOUT_MS = 30_000;
const RENDER_DELAY_MS = 3_000;  // post-DCL wait so React/Vue can mount + render
// Why not 'networkidle': many real sites keep a persistent connection open
// (analytics beacons, chat widgets, live-data poll). networkidle never fires,
// the timeout trips, and the navigation throws BEFORE we can extract anything.
// DOMContentLoaded + a generous render delay is reliable across SPA frameworks
// without depending on quiescent network behaviour that the site may never
// actually reach.

// Lazy-initialised, lifecycle-managed Chromium. ONE browser process per
// worker (cold start ~1s; subsequent pages share it). Each page gets its
// own incognito-style context so cookies / localStorage don't bleed
// between sites. The browser is never explicitly closed during the
// worker's lifetime — the process restart on each deploy bounds the
// memory footprint.
let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return _browser;
}

// Strip a leading "www." from a hostname so the apex of legabarit.com and
// www.legabarit.com (and any subdomain off either) all evaluate as the
// same business. Doesn't claim public-suffix-list accuracy — for the
// common case (.com / .org / .net + most country TLDs operators use)
// the apex is the rightmost two labels after the trim.
function apexOf(hostname: string): string {
  const cleaned = hostname.replace(/^www\./i, '').toLowerCase();
  return cleaned;
}

// Two URLs share a base domain when the candidate's hostname equals the
// root's apex hostname, OR is a subdomain of it. Allows the crawler to
// follow legabarit.com → store.legabarit.com → shop.legabarit.com (the
// canonical pattern for a marketing site + separate e-commerce store)
// without wandering onto Facebook / Instagram / partner sites.
function sameBaseDomain(candidate: URL, root: URL): boolean {
  const candidateHost = candidate.hostname.toLowerCase();
  const rootApex = apexOf(root.hostname);
  if (candidateHost === rootApex) return true;
  if (candidateHost.endsWith('.' + rootApex)) return true;
  // Also accept candidate-with-www if the root was the apex.
  if (candidateHost === 'www.' + rootApex) return true;
  return false;
}

function cleanText($: cheerio.CheerioAPI): string {
  // Strip noise.
  $('script, style, noscript, iframe, svg, header nav, footer, [aria-hidden="true"]').remove();
  // Inline all-text approach — collapse whitespace.
  const raw = $('body').text() || $('html').text();
  return raw.replace(/[\t\r\n]+/g, '\n').replace(/[ ]{2,}/g, ' ').trim().slice(0, MAX_BODY_BYTES);
}

async function fetchOnePage(url: string): Promise<{
  status: number;
  contentType: string | null;
  html: string | null;
  error?: string;
}> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    // SSRF pre-flight: Chromium does its own DNS, so the pinning dispatcher
    // can't protect page.goto. Resolve the host ourselves and refuse private/
    // loopback/link-local targets (incl. cloud-metadata) before navigating.
    await assertUrlResolvesPublic(url);
    const browser = await getBrowser();
    // Fresh context per page: isolated cookies / storage so cross-site
    // tracking + previous-page side effects can't influence this fetch.
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)' +
        ' Chrome/120.0.0.0 Safari/537.36 the platformBot/1.0 (+https://example.com/bot)',
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
      // Most public marketing sites don't gate on locale; defaulting to
      // en-US is the safest baseline. The bot itself handles whatever
      // language the rendered content arrives in.
      locale: 'en-US',
    });
    page = await context.newPage();

    // Block images / media / fonts so the crawler isn't pulling MBs of
    // assets it'll never use. Stylesheets stay enabled because some
    // sites render content only when CSS resolves (rare but real).
    // Documents / scripts / xhr / fetch all proceed normally — the
    // whole point of using Playwright is to let the JS run.
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    // Wait for the document to parse — fires quickly + reliably even
    // when the page keeps long-running network connections open. If
    // DCL doesn't fire within the budget (heavy CF challenge, hung
    // analytics script, infinite-redirect-loop guard), fall back to
    // 'commit' which resolves as soon as the response starts
    // streaming. We then sit for a longer render delay and take
    // whatever HTML the page produced. Better than a hard fail —
    // for static-rendered sites we still get the full HTML; for
    // SPAs we get the shell + whatever rendered before the timeout.
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      // Give React / Vue / Next-app-router time to mount + render
      // after DCL. Most SPAs render their main content within 1-3s
      // of DCL once their hydration script runs.
      await page.waitForTimeout(RENDER_DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/timeout|exceeded/i.test(msg)) throw err;
      // Retry with 'commit' — fires as soon as the response begins
      // arriving, no wait for DCL. Use a fresh nav-timeout budget,
      // then sit for 2x render delay so most static HTML appears
      // before we read page.content().
      response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(RENDER_DELAY_MS * 2);
    }

    const status = response?.status() ?? 0;
    const ctypeHeader = response?.headers()['content-type'] ?? null;
    // Always grab page.content() — that's the FULLY RENDERED HTML, not
    // the original document.
    const html = await page.content();
    return { status, contentType: ctypeHeader, html };
  } catch (err) {
    return {
      status: 0,
      contentType: null,
      html: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      if (page) await page.close({ runBeforeUnload: false });
    } catch { /* noop */ }
    try {
      if (context) await context.close();
    } catch { /* noop */ }
  }
}

function extractLinks($: cheerio.CheerioAPI, base: URL): URL[] {
  const out: URL[] = [];
  $('a[href]').each((_i, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const u = new URL(href, base);
      if (sameBaseDomain(u, base)) out.push(u);
    } catch {
      /* ignore */
    }
  });
  return out;
}

// Pull every <img> URL from the page (rendered by Playwright before this
// runs, so JS-injected images are included). Returns absolute URLs with
// the alt text — both useful to the LLM when it pairs an image to a
// product card. Skips data: URIs, tracking pixels (≤2x2 effective), and
// SVG-spritesheet refs. Capped at 200 entries per page to keep the LLM
// prompt under any context limits.
function extractImages(
  $: cheerio.CheerioAPI,
  base: URL,
): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  const seen = new Set<string>();
  $('img').each((_i, el) => {
    if (out.length >= 200) return;
    const $el = $(el);
    // Real sites stash the actual src on data-src / srcset for lazy-load.
    // Prefer the first explicit src; fall back to data-src / data-original
    // / first entry of srcset.
    const raw =
      ($el.attr('src') ?? '').trim() ||
      ($el.attr('data-src') ?? '').trim() ||
      ($el.attr('data-original') ?? '').trim() ||
      (($el.attr('srcset') ?? '').split(',')[0] ?? '').trim().split(' ')[0] ||
      '';
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
    try {
      const u = new URL(raw, base);
      const key = u.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const alt = ($el.attr('alt') ?? '').trim().slice(0, 120);
      out.push({ url: key, alt });
    } catch {
      /* malformed src — ignore */
    }
  });
  return out;
}

export function startCrawlWorker() {
  const worker = new Worker<CrawlPayload>(
    'crawl',
    async (job) => {
      const { organizationId, crawlJobId } = job.data;
      const meta = await prisma.crawlJob.findUnique({ where: { id: crawlJobId } });
      if (!meta) return;

      // Defence in depth: if the job payload's orgId doesn't match the crawl
      // job row's orgId (stale/forged queue entry, data corruption), refuse
      // rather than persist crawled pages / KB rows into the wrong tenant.
      // Mirrors sync.ts.
      if (meta.organizationId !== organizationId) {
        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status: 'failed',
            errorMessage: 'Crawl job does not belong to the job organization.',
            finishedAt: new Date(),
          },
        });
        return;
      }

      try {
        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: { status: 'running', startedAt: new Date() },
        });

        // SSRF guard.
        let rootUrl: URL;
        try {
          rootUrl = assertSafeOutboundUrl(meta.rootUrl);
        } catch (err) {
          await prisma.crawlJob.update({
            where: { id: crawlJobId },
            data: {
              status: 'failed',
              errorMessage: err instanceof UrlGuardError ? err.message : 'Refused outbound URL.',
              finishedAt: new Date(),
            },
          });
          return;
        }

        // Seed the BFS `seen` set from any crawl_pages already persisted
        // for THIS crawl_job — happens when BullMQ retries us after a
        // worker SIGTERM mid-job (attempts:3 on the queue). Without this
        // seed, the retry would re-fetch every page we already have,
        // burning quota + Playwright minutes for no benefit. URLs in the
        // seed are added to `seen` (so we never enqueue them again) but
        // NOT to the corpus — the prior attempt already ran extractors
        // inline on each, and re-running would just double-bill.
        const existingPages = await prisma.crawlPage.findMany({
          where: { crawlJobId },
          select: { url: true, fetchStatus: true },
        });
        const seen = new Set<string>([rootUrl.toString()]);
        for (const p of existingPages) {
          seen.add(p.url);
        }
        // If we are resuming, log it so an operator looking at the worker
        // log can see what happened.
        if (existingPages.length > 0) {
          console.info(`[crawl] resuming job ${crawlJobId} — ${existingPages.length} URLs already seen`);
        }
        const queue: { url: URL; depth: number }[] = [{ url: rootUrl, depth: 0 }];
        // Pre-seed crawled / failed counts so the live status badge keeps
        // climbing instead of jumping back to 0 on retry.
        let crawled = existingPages.filter((p) => (p.fetchStatus ?? 0) >= 200 && (p.fetchStatus ?? 0) < 400).length;
        let failed = existingPages.length - crawled;
        let dedupSkipped = 0;
        const cleanCorpus: CorpusPage[] = [];
        // Body-hash dedup. SPAs typically render the same shell for any
        // URL whose JS reads ?param=… and filters client-side — an SPA's
        // /properties?location=beirut etc. all return the identical
        // 22,904-char body. Without this, the crawl wastes ~3s per dupe
        // page AND ships duplicate content to the LLM analyse step,
        // both bloating tokens and skewing the KB toward whatever the
        // SPA happens to dump on every URL. We hash the cleaned body
        // text after extraction; if a hash collides with one we've
        // already stored, we drop the row + don't enqueue any links
        // from it (its links are by definition the same as the dupe).
        const { createHash } = await import('node:crypto');
        const seenBodyHashes = new Set<string>();
        // URLs the inline per-page extractor already handled successfully
        // (no thrown error). The post-BFS extractAndPersistListings sweep
        // skips these so we don't double-bill OpenAI gpt-4o-mini for the
        // same listing pages during a Groq quota burn. Per the 2026-06-01
        // review: without this, a 30-page listings crawl on fallback
        // costs ~$0.30 instead of ~$0.10.
        const inlineExtractedUrls = new Set<string>();

        while (queue.length > 0 && crawled + failed < meta.maxPages) {
          // Cancellation check. The operator can flip the job's status to
          // 'cancelled' from /bot at any time; the worker picks it up at
          // each page boundary and exits cleanly. We don't re-read the
          // row on every loop — once every 3 pages is plenty (~9s at the
          // new ~3s/page pace) and keeps DB chatter bounded.
          if ((crawled + failed) % 3 === 0) {
            const current = await prisma.crawlJob.findUnique({
              where: { id: crawlJobId },
              select: { status: true },
            });
            if (current?.status === 'cancelled') {
              await prisma.crawlJob.update({
                where: { id: crawlJobId },
                data: {
                  pagesCrawled: crawled,
                  pagesFailed: failed,
                  finishedAt: new Date(),
                  errorMessage: 'Crawl stopped by operator.',
                },
              });
              return; // exit the worker handler — BullMQ marks the job done
            }
          }
          // Shutdown check. On every page boundary, peek at the
          // worker-level shutdown flag — if a SIGTERM has arrived
          // (deploy / OOM / systemd restart), throw a typed error so
          // BullMQ marks this attempt failed and queues a retry. The
          // crawl_job DB row stays at 'running'; the new worker boot
          // picks the job back up (BullMQ persists active job IDs)
          // and the BFS resumes via the seen-set seed above.
          if (isWorkerShuttingDown()) {
            throw new Error('Worker shutting down — crawl will resume on next worker boot.');
          }
          const next = queue.shift()!;
          const r = await fetchOnePage(next.url.toString());
          if (r.error || !r.html) {
            failed += 1;
            await prisma.crawlPage.create({
              data: {
                organizationId,
                crawlJobId,
                url: next.url.toString(),
                fetchStatus: r.status,
                errorMessage: r.error ?? `Non-HTML (${r.contentType ?? 'unknown'})`,
              },
            });
            continue;
          }
          const $ = cheerio.load(r.html);
          const title = $('title').first().text().trim() || null;
          // Order matters here. extractLinks reads <a href> across the
          // whole document; cleanText calls .remove() on header/nav/
          // footer/script/style which would DESTROY the navigation
          // anchors that extractLinks needs to walk. Pre-2026-05-27
          // these ran in the wrong order and the crawler queued zero
          // children on any site whose nav was wrapped in proper
          // <header><nav>...</nav></header> (most modern frameworks).
          const childLinks = next.depth < meta.maxDepth
            ? extractLinks($, next.url)
            : [];
          const text = cleanText($);

          // Body-hash dedup. Skip pages whose extracted prose matches a
          // page we've already crawled — typically client-side filter
          // variants (e.g. /properties?location=beirut returning the
          // identical shell as /properties). We DON'T enqueue children
          // from a dupe page either: they'd be the same children as
          // the page we already have.
          const bodyHash = createHash('sha256').update(text).digest('hex');
          if (text.length > 0 && seenBodyHashes.has(bodyHash)) {
            dedupSkipped += 1;
            // Continue without persisting / enqueuing. Don't count as
            // a failure either — it's a deliberate skip.
            continue;
          }
          seenBodyHashes.add(bodyHash);

          await prisma.crawlPage.create({
            data: {
              organizationId,
              crawlJobId,
              url: next.url.toString(),
              fetchStatus: r.status,
              title,
              bodyText: text || null,
            },
          });
          // Extract <img> URLs alongside the prose. Listing-page LLM
          // extraction uses them to attach a thumbnail to each product
          // it surfaces. We capture from the cheerio handle BEFORE the
          // next iteration discards it.
          const pageImages = extractImages($, next.url);
          cleanCorpus.push({ url: next.url.toString(), title, text, images: pageImages });
          crawled += 1;
          await prisma.crawlJob.update({
            where: { id: crawlJobId },
            data: { pagesCrawled: crawled, pagesFailed: failed },
          });
          // Inline listing extraction. If this page LOOKS like a listing
          // page (multiple price patterns + repeating card structure) AND
          // an LLM is configured, kick off the extraction immediately so
          // the operator's review panel populates LIVE during BFS — they
          // don't have to wait for the whole site to finish crawling
          // before seeing the first product. Errors swallowed; BFS keeps
          // going. The post-BFS pass below catches anything that slipped
          // through (e.g. a transient LLM timeout on this iteration).
          if (isOpenAIConfigured() && text) {
            const pageCorpus: CorpusPage = {
              url: next.url.toString(),
              title,
              text,
              images: pageImages,
            };
            if (looksLikeListingPage(text)) {
              try {
                await extractListingsFromPage(organizationId, crawlJobId, pageCorpus);
                inlineExtractedUrls.add(next.url.toString());
              } catch (err) {
                console.warn(
                  '[crawl] inline listing extraction failed for',
                  next.url.toString(),
                  err instanceof Error ? err.message : err,
                );
              }
            } else if (looksLikeBusinessContentPage(next.url.toString(), title, meta.rootUrl)) {
              // Non-listing page that smells like contact / about / FAQ /
              // policy / hours. One LLM call returns ALL of these in one
              // shot and we persist into the right tables. So the
              // operator sees FAQs, contact channels, locations and the
              // business description populate LIVE as the crawl walks
              // the site instead of having to wait for a single post-BFS
              // sweep that they might miss.
              try {
                await extractAndPersistBusinessContent(organizationId, crawlJobId, pageCorpus);
              } catch (err) {
                console.warn(
                  '[crawl] inline business-content extraction failed for',
                  next.url.toString(),
                  err instanceof Error ? err.message : err,
                );
              }
            }
          }
          // Enqueue children we just collected (before cleanText nuked
          // the source elements).
          if (next.depth < meta.maxDepth) {
            for (const link of childLinks) {
              const key = link.toString().split('#')[0]!;
              if (seen.has(key)) continue;
              seen.add(key);
              // SSRF: refuse to enqueue a discovered link that points at a
              // private/loopback/literal-IP host (the per-page goto also DNS-
              // resolves, but drop obvious ones up front).
              try {
                assertSafeOutboundUrl(key);
              } catch {
                continue;
              }
              queue.push({ url: new URL(key), depth: next.depth + 1 });
            }
          }
        }

        console.info(
          `[crawl] BFS finished: crawled=${crawled} failed=${failed} ` +
            `dedup_skipped=${dedupSkipped} unique_bodies=${seenBodyHashes.size} ` +
            `corpus_chars=${cleanCorpus.reduce((s, p) => s + p.text.length, 0)}`,
        );

        // Run LLM analysis if configured. Otherwise mark partial.
        let analysisOK = false;
        let listingsCreated = 0;
        if (isOpenAIConfigured() && cleanCorpus.length > 0) {
          analysisOK = await analyzeAndPersist(organizationId, cleanCorpus).catch((err) => {
            console.error('[crawl] analysis failed', err);
            return false;
          });
          // Second pass: extract per-listing structured products from any
          // listing-shaped page (multiple price patterns + repeating card
          // structure). Lands as DRAFT products (isAvailable=false) so
          // the operator reviews before they go live in the bot.
          listingsCreated = await extractAndPersistListings(
            organizationId,
            crawlJobId,
            cleanCorpus,
            inlineExtractedUrls,
          ).catch((err) => {
            console.error('[crawl] listings extract failed', err);
            return 0;
          });
          if (listingsCreated > 0) {
            console.info(`[crawl] extracted ${listingsCreated} draft Product rows from listing pages`);
          }
        }

        const status = failed > 0 && crawled === 0 ? 'failed' : analysisOK ? 'succeeded' : 'partial';
        // Only surface the AI-key notice when the crawl part actually
        // worked. Otherwise the per-page fetch error is the useful signal
        // and we'd rather not mask it.
        let errorMessage: string | null = null;
        if (status === 'failed') {
          const firstFailure = await prisma.crawlPage.findFirst({
            where: { crawlJobId, errorMessage: { not: null } },
            select: { url: true, errorMessage: true, fetchStatus: true },
          });
          errorMessage = firstFailure
            ? `Fetch failed: ${firstFailure.errorMessage} (${firstFailure.url}, status ${firstFailure.fetchStatus})`
            : 'Crawl failed before any page was fetched.';
        } else if (!isOpenAIConfigured()) {
          errorMessage =
            'No LLM provider configured (set GROQ_API_KEY and/or OPENAI_API_KEY) — pages crawled but no KB generated.';
        }

        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status,
            pagesCrawled: crawled,
            pagesFailed: failed,
            finishedAt: new Date(),
            errorMessage,
          },
        });
      } catch (err) {
        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          },
        });
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: env.CRAWL_CONCURRENCY,
    },
  );
  // BullMQ marks a job 'failed' on every thrown attempt. We only want
  // to update the CrawlJob DB row to 'failed' when ALL attempts have
  // been exhausted — otherwise an intermediate stall would prematurely
  // flip status='failed' even though BullMQ is about to retry.
  worker.on('failed', async (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    try {
      await prisma.crawlJob.update({
        where: { id: job.data.crawlJobId },
        data: {
          status: 'failed',
          errorMessage:
            err.message ||
            'Crawl failed after exhausting retry budget. Start a new crawl to try again.',
          finishedAt: new Date(),
        },
      });
    } catch {
      /* row may already be terminal — ignore */
    }
  });
  return worker;
}

// ----- LLM step ------------------------------------------------------------
async function analyzeAndPersist(
  organizationId: string,
  corpus: CorpusPage[],
): Promise<boolean> {
  // Compose a compact corpus string. Trim each page's body to keep total
  // under ~30 KB so we don't blow the model context unnecessarily.
  const PAGE_BUDGET = 4_000;
  const joined = corpus
    .slice(0, 12)
    .map((p) => `## ${p.title ?? p.url}\n[url: ${p.url}]\n\n${p.text.slice(0, PAGE_BUDGET)}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are a business analyst extracting a knowledge base from a company's website.

You will receive concatenated text from up to 12 pages of one company's website. Produce STRICT JSON with three fields:
- "tone": one of "formal", "casual", "friendly", "clinical", or "professional" (best fit)
- "summary": a one-sentence description of the business
- "entries": an array of up to 25 FAQ-shaped knowledge-base entries:
    - "kind": one of "faq", "product", "service", "policy", "business_info"
    - "question": the question a customer would ask
    - "answer": a concise answer (max 600 characters)
    - "sourceUrl": the URL on the site that supports this entry, when known

Rules:
- ONLY emit JSON. No markdown fences, no explanation.
- Skip entries you can't ground in the source text. Better fewer accurate than many speculative.
- Prefer concrete factual claims (hours, prices, return policy, contact channels) over generic marketing copy.
- Phrase answers in the company's detected tone.`;

  const userPrompt = `# Source pages\n\n${joined.slice(0, 60_000)}`;

  let llm: Awaited<ReturnType<typeof workerComplete>>;
  try {
    llm = await workerComplete({
      systemPrompt,
      userPrompt,
      maxTokens: 4_000,
      temperature: 0.2,
      // JSON mode — Groq returns only a valid JSON object, no preamble,
      // no code fences. Eliminates the entire class of "model wrapped
      // its output in ```json or added 'Here you go:' before it" parse
      // failures that the regex-strip below used to swallow silently.
      jsonMode: true,
    });
  } catch (err) {
    console.error('[crawl] LLM call failed', err instanceof Error ? err.message : err);
    return false;
  }

  type Parsed = {
    tone?: string;
    summary?: string;
    entries?: { kind: string; question: string; answer: string; sourceUrl?: string }[];
  };
  // Robust JSON extraction: prefer the whole text (jsonMode should make
  // it pure JSON), but fall back to a `{ ... }` slice if the model snuck
  // in any wrapping prose anyway.
  function extractJsonBlock(s: string): string {
    const trimmed = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    if (trimmed.startsWith('{')) return trimmed;
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
    return trimmed;
  }

  let parsed: Parsed | null = null;
  try {
    parsed = JSON.parse(extractJsonBlock(llm.text)) as Parsed;
  } catch (err) {
    parsed = null;
    console.warn(
      '[crawl] could not parse LLM output as JSON',
      err instanceof Error ? err.message : err,
      '— first 400 chars of output:',
      llm.text.slice(0, 400),
    );
  }
  if (!parsed) return false;

  await withRlsBypass(async (tx) => {
    // Upsert detected tone onto the bot config (create the row if missing).
    await tx.botConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        detectedTone: parsed?.tone ?? null,
        personality: parsed?.tone ?? null,
        version: 1,
      },
      update: {
        detectedTone: parsed?.tone ?? undefined,
        version: { increment: 1 },
      },
    });

    // Replace any existing AI-generated KB rows. Keeps re-runs idempotent
    // without nuking manual rows the client added.
    await tx.knowledgeBaseEntry.deleteMany({
      where: { organizationId, sourceType: 'ai' },
    });

    const entries = (parsed.entries ?? []).slice(0, 50);
    for (const e of entries) {
      if (!e.question || !e.answer) continue;
      const kind = ['faq', 'product', 'service', 'policy', 'business_info'].includes(e.kind)
        ? e.kind
        : 'faq';
      await tx.knowledgeBaseEntry.create({
        data: {
          organizationId,
          kind,
          question: e.question.slice(0, 500),
          answer: e.answer.slice(0, 2000),
          sourceUrl: e.sourceUrl?.slice(0, 1000) ?? null,
          sourceType: 'ai',
          approved: false,
          searchText: `${e.question} ${e.answer}`.toLowerCase().slice(0, 4000),
        },
      });
    }
  });

  return true;
}

// ----------------------------------------------------------------------------
// Listings → Products extractor
// ----------------------------------------------------------------------------
// Many tenant sites are catalogues at heart — real-estate listing pages,
// restaurant menus, dealership inventories, service directories. The
// crawler captures the listing PAGE (one URL, many cards inside) but
// individual detail pages are usually behind JS onClick handlers with
// no <a href> the BFS can follow.
//
// This extractor takes the rendered prose of each listing-shaped page
// and asks the LLM to return STRUCTURED products. Each product becomes
// a Product row in the tenant's catalog as a DRAFT (isAvailable=false)
// — the operator reviews + publishes via /products.
//
// Idempotency: SKU is a deterministic hash of name+location, so a
// re-crawl picking up the same listings upserts rather than duplicates.
// We only update existing rows that are STILL drafts; operator-edited
// or operator-published rows are left alone so manual fixes survive.

const PRICE_LIKE_RE = /(?:\$|€|£|USD|EUR|GBP|KWD|AED|SAR|BHD|OMR|JOD|LBP|EGP)[\s\d.,/-]{1,30}|[\d.,]{1,12}\s*(?:USD|EUR|GBP|KWD|AED|SAR|BHD|OMR|JOD|LBP|EGP|\$|€|£)/gi;

function looksLikeListingPage(text: string): boolean {
  if (!text) return false;
  // 8+ price-shaped tokens = "this page has a list of things with prices".
  const prices = text.match(PRICE_LIKE_RE);
  return (prices?.length ?? 0) >= 8;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

type ExtractedProduct = {
  name?: string;
  shortDescription?: string;
  description?: string;
  priceMajor?: number | string | null;
  currency?: string;
  location?: string;
  category?: string;
  attributes?: Record<string, unknown>;
  imageIndex?: number | null;
};
type ExtractedShape = { products?: ExtractedProduct[] };

function extractJsonBlock(s: string): string {
  const trimmed = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  if (trimmed.startsWith('{')) return trimmed;
  const f = trimmed.indexOf('{');
  const l = trimmed.lastIndexOf('}');
  return f >= 0 && l > f ? trimmed.slice(f, l + 1) : trimmed;
}

const LISTINGS_SYSTEM_PROMPT = `You extract individual product listings from a category / inventory / directory page.
Return STRICT JSON in this shape, nothing else:

{
  "products": [
    {
      "name": "<exact name from the page>",
      "shortDescription": "<one or two sentences summarizing key features, max 200 chars>",
      "description": "<longer-form description, every relevant detail from the listing card or its detail link: features, amenities, condition, included items, dimensions, finishes, terms. Plain prose, max 1500 chars. Empty string when the page only shows a title and a price.>",
      "priceMajor": <number, the price as a normal decimal e.g. 550000 or 1.250 or null if unclear>,
      "currency": "<ISO 4217 code e.g. USD, KWD, EUR>",
      "location": "<location/region string from the listing, or empty string>",
      "category": "<best one-word category: 'Apartment', 'Villa', 'Land', 'Office', 'Commercial', 'Service', 'Product', etc.>",
      "attributes": {"bedrooms": <int or null>, "bathrooms": <int or null>, "sqm": <int or null>},
      "imageIndex": <integer — the 1-based index of the best matching image URL from the "Image URLs" section below, or 0 if none of them belong to this listing>
    }
  ]
}

Rules:
- Extract every distinct listing you can confidently identify. Cap at 60 per response.
- name + currency are required. Skip cards missing either.
- Use the EXACT name and price text as shown — do not paraphrase or round.
- priceMajor is the human-readable number (not minor units): 550000 for $550,000; 1.250 for 1.250 KWD.
- attributes keys may be empty when the listing doesn't say. Don't invent values.
- description should pull EVERY descriptive sentence the listing exposes — don't summarise it down to one line. The chatbot will quote from it directly.
- imageIndex: pick the image whose URL filename or alt text matches the listing (e.g. matches the product name, SKU, or has alt text describing it). If no image clearly belongs to this listing, return 0. NEVER guess — wrong image is worse than no image.
- Skip duplicates within the same response.`;

// Run the listing LLM extraction for ONE page and persist any products
// it produces. Called inline from the BFS so rows appear in the operator's
// review panel the moment the worker finishes a listing-shaped page,
// instead of all-at-once after the entire crawl completes. Returns the
// number of products created or updated. Errors are swallowed and logged
// — a failed extraction must never break BFS progress.
export async function extractListingsFromPage(
  organizationId: string,
  crawlJobId: string,
  page: CorpusPage,
): Promise<number> {
  // Build the indexed image list the LLM uses to pair products to
  // thumbnails. Cap at 80 entries so even image-heavy listing pages
  // don't blow the prompt — most cards we care about appear in the
  // first ~30 anyway. Index is 1-based so 0 can mean "no image".
  const promptImages = page.images.slice(0, 80);
  const imagesBlock = promptImages.length
    ? promptImages
        .map((img, i) => {
          const altPart = img.alt ? ` (alt: "${img.alt.slice(0, 80)}")` : '';
          return `${i + 1}. ${img.url}${altPart}`;
        })
        .join('\n')
    : '(none on this page)';

  // Cap each page's text at ~40 KB so the LLM call stays well under
  // any context-window or rate-limit edge case.
  const userPrompt =
    `# Source URL\n${page.url}\n\n` +
    `# Page content\n\n${page.text.slice(0, 40_000)}\n\n` +
    `# Image URLs available on this page\n${imagesBlock}`;

  let llm: Awaited<ReturnType<typeof workerComplete>>;
  try {
    llm = await workerComplete({
      systemPrompt: LISTINGS_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 4_000,
      temperature: 0.2,
      jsonMode: true,
    });
  } catch (err) {
    console.error('[crawl] listings LLM call failed for', page.url, err instanceof Error ? err.message : err);
    return 0;
  }

  let extracted: ExtractedShape | null = null;
  try {
    extracted = JSON.parse(extractJsonBlock(llm.text)) as ExtractedShape;
  } catch (err) {
    console.warn(
      '[crawl] listings JSON parse failed for', page.url,
      err instanceof Error ? err.message : err,
      '— first 400 chars:', llm.text.slice(0, 400),
    );
    return 0;
  }
  const products = (extracted?.products ?? []).slice(0, 60);
  if (products.length === 0) return 0;

  const { createHash } = await import('node:crypto');
  let created = 0;
  // Image jobs collected during the persist txn and run AFTER it commits.
  // Each download is 1-10 s of remote network IO; doing it inside the txn
  // would hold the row locks open and bloat the connection pool. We also
  // skip the work entirely on rows the operator has already touched.
  const imageJobs: { productId: string; imageUrl: string; alt: string }[] = [];
  await withRlsBypass(async (tx) => {
    // Look up the org's default currency once for fallback / price
    // conversion (KWD/BHD/OMR/JOD use 1000, others use 100).
    const biz = await tx.businessInfo.findFirst({
      where: { organizationId },
      select: { currency: true },
    });
    const orgCurrency = (biz?.currency ?? 'USD').toUpperCase();

    for (const p of products) {
      if (!p.name || p.name.trim().length === 0) continue;
      const name = p.name.trim().slice(0, 200);
      const currency = (p.currency ?? orgCurrency).toUpperCase().slice(0, 3);
      // Convert priceMajor to minor units. Handle string + number inputs.
      let priceMinor: number | null = null;
      if (p.priceMajor != null && p.priceMajor !== '') {
        const major = typeof p.priceMajor === 'string'
          ? Number(p.priceMajor.replace(/[^0-9.]/g, ''))
          : Number(p.priceMajor);
        if (Number.isFinite(major) && major > 0) {
          const multiplier = ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 1000 : 100;
          priceMinor = Math.round(major * multiplier);
        }
      }

      // Deterministic SKU per (name, location) — same listing across
      // re-crawls produces the same SKU so upsert is idempotent.
      const skuBase = createHash('sha256')
        .update(`${name}|${p.location ?? ''}`.toLowerCase())
        .digest('hex')
        .slice(0, 10)
        .toUpperCase();
      const sku = `CRAWL-${skuBase}`;
      // Slug shape: `crawl-<10-char hash>-<name-suffix>`.
      // shared/slugSchema caps slugs at 48 chars and forbids a trailing
      // hyphen. `crawl-` (6) + hash (10) + `-` (1) = 17 chars of
      // prefix, so the suffix must stay <= 31. Then strip any trailing
      // `-` that survives the slice so the regex passes. Without this
      // the response schema rejects the row and the whole products
      // list 500s — see crawler import bug 2026-06-01.
      const namePart = slugifyName(name).slice(0, 31).replace(/-+$/, '');
      const slug = namePart
        ? `crawl-${skuBase.toLowerCase()}-${namePart}`
        : `crawl-${skuBase.toLowerCase()}`;

      const attributes: Record<string, unknown> = {
        ...(p.attributes ?? {}),
        source: 'crawl',
        crawlJobId,
        sourceUrl: page.url,
      };
      if (p.location) attributes.location = String(p.location).slice(0, 200);
      if (p.category) attributes.category = String(p.category).slice(0, 60);

      // Only touch existing rows that are STILL drafts. If the operator
      // has published or edited a row, the re-crawl leaves it alone so
      // manual fixes survive.
      const existing = await tx.product.findUnique({
        where: { organizationId_sku: { organizationId, sku } },
        select: { id: true, isAvailable: true, attributes: true },
      });
      const stillDraft =
        existing && !existing.isAvailable &&
        (existing.attributes as Record<string, unknown> | null)?.source === 'crawl';

      if (existing && !stillDraft) {
        // Operator-managed row — skip silently.
        continue;
      }

      const shortDescription = p.shortDescription?.trim().slice(0, 200) || null;
      const description = p.description?.trim().slice(0, 1500) || null;

      // Resolve the image the LLM picked for this listing. 1-based
      // index into `promptImages`; 0 / null / out-of-range = no image.
      const idx = Number(p.imageIndex);
      const chosenImage =
        Number.isFinite(idx) && idx >= 1 && idx <= promptImages.length
          ? promptImages[idx - 1]!
          : null;

      let persistedProductId: string | null = null;
      if (existing && stillDraft) {
        await tx.product.update({
          where: { id: existing.id },
          data: {
            name,
            shortDescription,
            description,
            priceMinor,
            currency,
            attributes: attributes as never,
          },
        });
        persistedProductId = existing.id;
        created += 1;
      } else {
        try {
          const fresh = await tx.product.create({
            data: {
              organizationId,
              sku,
              name,
              slug,
              shortDescription,
              description,
              priceMinor,
              currency,
              isAvailable: false, // DRAFT — operator must publish via /products
              attributes: attributes as never,
            },
            select: { id: true },
          });
          persistedProductId = fresh.id;
          created += 1;
        } catch (err) {
          // Slug collision is the most likely cause — another draft
          // with a near-identical name. Skip and move on.
          console.warn('[crawl] product create failed for', name, err instanceof Error ? err.message : err);
        }
      }

      if (persistedProductId && chosenImage) {
        // Skip if we already have an image attached — re-crawls shouldn't
        // duplicate. A single image per product is the v1 contract; the
        // operator can add more manually.
        const existingImage = await tx.productImage.findFirst({
          where: { productId: persistedProductId },
          select: { id: true },
        });
        if (!existingImage) {
          imageJobs.push({
            productId: persistedProductId,
            imageUrl: chosenImage.url,
            alt: chosenImage.alt,
          });
        }
      }
    }
  });

  // Image downloads run AFTER the persist txn so a stalled remote host
  // can't hold a DB connection open. Each job is wrapped so one bad URL
  // doesn't sink the rest.
  for (const job of imageJobs) {
    try {
      await downloadAndAttachImage(organizationId, job);
    } catch (err) {
      console.warn(
        '[crawl] image download failed for', job.imageUrl,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return created;
}

// ---------- per-page business-content extractor ----------------------------
// Routes the prose on non-listing pages (about / contact / FAQ / policy /
// hours / location pages) into the correct tenant tables in real time
// during BFS. Without this step the crawl ended with a fully populated
// product catalog but BusinessInfo / ContactChannels / FAQs / Policies
// still empty — operator had to copy-paste from the site by hand.
//
// Operator-protection rule: we ONLY insert rows that don't already exist
// AND only overwrite BusinessInfo fields that are currently null/empty.
// A re-crawl never silently destroys a manual edit.

// Pages we send to the unified extractor. Cheap regex on URL + title
// keeps the per-page LLM fan-out bounded — random product/blog/category
// pages are routed to the listing extractor or skipped, not double-billed.
function looksLikeBusinessContentPage(
  url: string,
  title: string | null,
  rootUrl: string,
): boolean {
  const haystack = `${url.toLowerCase()} ${(title ?? '').toLowerCase()}`;
  // The home page nearly always carries the tagline + contact strip + a
  // location block — worth one LLM call.
  try {
    const u = new URL(url);
    const r = new URL(rootUrl);
    if ((u.pathname === '/' || u.pathname === '') && u.host === r.host) return true;
  } catch {
    /* malformed URL — fall through to the regex check */
  }
  return /contact|reach[-_ ]?us|get[-_ ]?in[-_ ]?touch|about|our[-_ ]?story|who[-_ ]?we[-_ ]?are|mission|\bfaq\b|frequently[-_ ]?asked|policy|privacy|terms|refund|\breturn[s]?\b|shipping|delivery|hours|opening|location[s]?\b|branches?\b|info\b|services?\b|treatments?\b|offerings?\b|packages?\b|\bmenu\b|booking|appointments?\b|consultations?\b|sessions?\b/i.test(
    haystack,
  );
}

type ExtractedBusinessContent = {
  contacts?: {
    kind?: string;
    label?: string | null;
    value?: string;
    isPrimary?: boolean | null;
  }[];
  locations?: {
    name?: string;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
    country?: string | null;
    phone?: string | null;
  }[];
  faqs?: { question?: string; answer?: string }[];
  policies?: {
    kind?: string;
    title?: string;
    content?: string;
  }[];
  businessInfo?: {
    about?: string | null;
    legalName?: string | null;
    tagline?: string | null;
    websiteUrl?: string | null;
    timezone?: string | null;
    currency?: string | null;
  };
  operatingHours?: {
    day?: string;
    open?: string | null;
    close?: string | null;
    closed?: boolean | null;
  }[];
  // Holiday / special-day rules. Optional; rare on websites but cheap to
  // ask the LLM and they're filled into BusinessInfo.hoursExceptions JSON.
  hoursExceptions?: {
    date?: string | null;
    closed?: boolean | null;
    open?: string | null;
    close?: string | null;
    note?: string | null;
  }[];
  // Services — extracted from /services, /treatments, /packages, /menu,
  // /booking pages. Same shape as our Service / ServicePricingTier /
  // AvailabilityWindow models. basePrice is a decimal string so the
  // LLM doesn't have to do minor-unit math — we convert on persist.
  services?: {
    name?: string;
    description?: string | null;
    shortDescription?: string | null;
    durationMinutes?: number | null;
    basePrice?: string | number | null;
    currency?: string | null;
    priceUnit?: string | null;
    tiers?: {
      name?: string;
      description?: string | null;
      price?: string | number | null;
      currency?: string | null;
      features?: string[];
    }[];
    availability?: {
      dayOfWeek?: string;
      startTime?: string | null;
      endTime?: string | null;
    }[];
  }[];
};

const BUSINESS_CONTENT_SYSTEM_PROMPT = `You are extracting structured business data from a single website page.
Read the page and return STRICT JSON in this shape. Leave any field empty when the page doesn't say.

{
  "contacts": [{"kind": "phone|email|whatsapp|instagram|facebook|x|tiktok|youtube|linkedin|address|other", "value": "<the literal value>", "label": "<optional friendly label or empty>"}],
  "locations": [{"name": "<branch / store name, or 'Main' if unnamed>", "addressLine1": "<street + number>", "addressLine2": "<unit/floor>", "city": "<city>", "region": "<state/governorate>", "postalCode": "<postal code>", "country": "<ISO 3166-1 alpha-2 like KW, US, AE>", "phone": "<phone if separate>"}],
  "faqs": [{"question": "<exact question text>", "answer": "<exact answer text, plain prose, max 1500 chars>"}],
  "policies": [{"kind": "return|shipping|privacy|terms|refund|other", "title": "<heading text>", "content": "<full policy body, plain prose, max 4000 chars>"}],
  "businessInfo": {"about": "<2-6 sentences describing the business, ONLY from an explicit 'About us' / 'Our story' / mission section. Empty otherwise.>", "legalName": "<legal entity name like 'Le Gabarit S.A.L.', empty otherwise>", "tagline": "<short marketing tagline if shown, empty otherwise>", "websiteUrl": "<canonical site url if present>", "timezone": "<IANA timezone if discernible>", "currency": "<ISO 4217 code if discernible>"},
  "operatingHours": [{"day": "monday|tuesday|wednesday|thursday|friday|saturday|sunday", "open": "HH:MM 24h or null when closed", "close": "HH:MM 24h or null when closed", "closed": <true if the day is explicitly listed as closed>}],
  "hoursExceptions": [{"date": "YYYY-MM-DD", "closed": <true|false>, "open": "HH:MM 24h or null", "close": "HH:MM 24h or null", "note": "<short label like 'Christmas Day' or empty>"}],
  "services": [{"name": "<service name as on the page>", "shortDescription": "<one-line summary, max 200 chars, empty if none>", "description": "<full prose description, plain text, max 4000 chars>", "durationMinutes": <minutes if stated, e.g. 60, else null>, "basePrice": "<decimal price like '50' or '49.99', null if not stated>", "currency": "<ISO 4217 like USD, EUR, KWD, AED — inferred from the price's symbol/code>", "priceUnit": "flat|per_hour|per_day|per_session|per_unit", "tiers": [{"name": "<tier name like 'Standard' / 'Premium' / 'VIP'>", "description": "<short prose>", "price": "<decimal>", "currency": "<ISO 4217>", "features": ["<bullet feature>", "<bullet feature>"]}], "availability": [{"dayOfWeek": "monday|tuesday|wednesday|thursday|friday|saturday|sunday", "startTime": "HH:MM 24h", "endTime": "HH:MM 24h"}]}]
}

Rules:
- Extract only what the page actually says. Don't invent.
- Contacts: values must look real (phone numbers with digits, email with @, social handles with platform handle). Skip otherwise.
- Locations: skip when the page only has a phone, no address.
- FAQs: only the literal Q&A pairs. Don't paraphrase. Empty array on a non-FAQ page.
- Policies: pick the single kind that best matches the page (one page typically = one policy).
- businessInfo.about: ONLY when the page is clearly an "About us" / "Our story" / mission page. Otherwise empty string.
- operatingHours: only when an explicit weekly schedule is shown.
- hoursExceptions: closed dates, special hours, holidays. Empty array when none.
- services: anything the business OFFERS as a bookable / standalone service (consultations, treatments, classes, packages, plans, appointments). Each distinct named offering becomes a service row. Set priceUnit to "flat" when unclear. Empty array when the page lists physical products only — products are handled elsewhere.
- service.tiers: only when the service has multiple price tiers / package levels on the same page (e.g. "Basic $50, Premium $100, VIP $200"). Otherwise empty array.
- service.availability: only when the page shows a per-service weekly schedule. Skip when the business-wide operatingHours apply.
- Return all-empty arrays / nulls when the page is generic (a blog post, navigation page, etc.) — that's the normal case.`;

async function extractAndPersistBusinessContent(
  organizationId: string,
  _crawlJobId: string,
  page: CorpusPage,
): Promise<void> {
  // Cap each page's text at ~30 KB so the prompt stays small. Most pages
  // we route here are short anyway (contact, about, FAQ are typically
  // under 5 KB).
  const userPrompt = `# Source URL\n${page.url}\n\n# Page content\n\n${page.text.slice(0, 30_000)}`;

  let llm: Awaited<ReturnType<typeof workerComplete>>;
  try {
    llm = await workerComplete({
      systemPrompt: BUSINESS_CONTENT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 4_000,
      temperature: 0.1,
      jsonMode: true,
    });
  } catch (err) {
    console.error('[crawl] business-content LLM call failed for', page.url, err instanceof Error ? err.message : err);
    return;
  }

  let extracted: ExtractedBusinessContent | null = null;
  try {
    extracted = JSON.parse(extractJsonBlock(llm.text)) as ExtractedBusinessContent;
  } catch (err) {
    console.warn(
      '[crawl] business-content JSON parse failed for', page.url,
      err instanceof Error ? err.message : err,
      '— first 400 chars:', llm.text.slice(0, 400),
    );
    return;
  }
  if (!extracted) return;

  await withRlsBypass(async (tx) => {
    // ----- BusinessInfo (fill-only-when-empty) -----
    const bi = extracted!.businessInfo ?? {};
    const hours = (extracted!.operatingHours ?? []).filter(
      (h) => h && typeof h.day === 'string' && /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(h.day),
    );
    const haveBiUpdate =
      (bi.about && bi.about.trim()) ||
      (bi.legalName && bi.legalName.trim()) ||
      (bi.tagline && bi.tagline.trim()) ||
      (bi.websiteUrl && bi.websiteUrl.trim()) ||
      (bi.timezone && bi.timezone.trim()) ||
      (bi.currency && bi.currency.trim()) ||
      hours.length > 0;
    if (haveBiUpdate) {
      const existing = await tx.businessInfo.findUnique({ where: { organizationId } });
      const data: Record<string, unknown> = {};
      // Only fill fields that are currently null / empty so an operator
      // edit always wins.
      if (bi.about && (!existing || !existing.about)) data.about = bi.about.trim().slice(0, 8000);
      if (bi.legalName && (!existing || !existing.legalName)) data.legalName = bi.legalName.trim().slice(0, 200);
      if (bi.tagline && (!existing || !existing.tagline)) data.tagline = bi.tagline.trim().slice(0, 200);
      if (bi.websiteUrl && (!existing || !existing.websiteUrl)) data.websiteUrl = bi.websiteUrl.trim().slice(0, 500);
      // timezone and currency have non-null defaults so only overwrite the
      // schema's default 'UTC' / 'USD' — never an operator's choice.
      if (bi.timezone && (!existing || existing.timezone === 'UTC')) data.timezone = bi.timezone.trim().slice(0, 64);
      if (bi.currency && (!existing || existing.currency === 'USD')) {
        const c = bi.currency.trim().toUpperCase().slice(0, 3);
        if (/^[A-Z]{3}$/.test(c)) data.currency = c;
      }
      if (hours.length > 0 && (!existing || existing.operatingHours == null)) {
        const grouped: Record<string, { open: string; close: string }[]> = {};
        for (const h of hours) {
          const day = h.day!.toLowerCase();
          if (h.closed === true) {
            grouped[day] = [];
            continue;
          }
          if (h.open && h.close && /^\d{1,2}:\d{2}$/.test(h.open) && /^\d{1,2}:\d{2}$/.test(h.close)) {
            (grouped[day] ??= []).push({ open: h.open, close: h.close });
          }
        }
        if (Object.keys(grouped).length > 0) {
          data.operatingHours = grouped as never;
        }
      }
      if (Object.keys(data).length > 0) {
        if (existing) {
          await tx.businessInfo.update({ where: { organizationId }, data });
        } else {
          await tx.businessInfo.create({
            data: { organizationId, ...(data as Record<string, never>) },
          });
        }
      }
    }

    // ----- ContactChannels (insert-if-not-exists by (kind, value)) -----
    for (const c of (extracted!.contacts ?? []).slice(0, 20)) {
      if (!c.kind || !c.value) continue;
      const kind = c.kind.toLowerCase().trim().slice(0, 32);
      const value = c.value.trim().slice(0, 500);
      if (!value) continue;
      const dupe = await tx.contactChannel.findFirst({
        where: { organizationId, kind, value },
        select: { id: true },
      });
      if (dupe) continue;
      await tx.contactChannel.create({
        data: {
          organizationId,
          kind,
          value,
          label: c.label?.trim().slice(0, 100) || null,
          isPrimary: !!c.isPrimary,
        },
      });
    }

    // ----- Locations (insert-if-not-exists by (name, city)) -----
    for (const l of (extracted!.locations ?? []).slice(0, 20)) {
      if (!l.name) continue;
      const name = l.name.trim().slice(0, 200);
      const city = l.city?.trim().slice(0, 100) || null;
      if (!name) continue;
      const dupe = await tx.location.findFirst({
        where: {
          organizationId,
          name: { equals: name, mode: 'insensitive' },
          ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
        },
        select: { id: true },
      });
      if (dupe) continue;
      const country = l.country?.trim().toUpperCase().slice(0, 2) || null;
      await tx.location.create({
        data: {
          organizationId,
          name,
          addressLine1: l.addressLine1?.trim().slice(0, 200) || null,
          addressLine2: l.addressLine2?.trim().slice(0, 200) || null,
          city,
          region: l.region?.trim().slice(0, 100) || null,
          postalCode: l.postalCode?.trim().slice(0, 32) || null,
          country: country && /^[A-Z]{2}$/.test(country) ? country : null,
          phone: l.phone?.trim().slice(0, 64) || null,
        },
      });
    }

    // ----- FAQs (insert-if-not-exists by question, case-insensitive) -----
    for (const f of (extracted!.faqs ?? []).slice(0, 60)) {
      if (!f.question || !f.answer) continue;
      const question = f.question.trim().slice(0, 500);
      const answer = f.answer.trim().slice(0, 4000);
      if (!question || !answer) continue;
      const dupe = await tx.fAQ.findFirst({
        where: {
          organizationId,
          question: { equals: question, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (dupe) continue;
      await tx.fAQ.create({
        data: { organizationId, question, answer },
      });
    }

    // ----- hoursExceptions (fill-only-when-currently-empty) -----
    {
      const raw = extracted!.hoursExceptions ?? [];
      const exceptions = raw
        .map((h) => ({
          date: h.date?.trim() ?? '',
          closed: h.closed === true,
          open: h.open?.trim() || null,
          close: h.close?.trim() || null,
          note: h.note?.trim() || null,
        }))
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date))
        .slice(0, 40);
      if (exceptions.length > 0) {
        const existing = await tx.businessInfo.findUnique({
          where: { organizationId },
          select: { hoursExceptions: true },
        });
        if (!existing || existing.hoursExceptions == null) {
          if (existing) {
            await tx.businessInfo.update({
              where: { organizationId },
              data: { hoursExceptions: exceptions as never },
            });
          } else {
            await tx.businessInfo.create({
              data: {
                organizationId,
                hoursExceptions: exceptions as never,
              },
            });
          }
        }
      }
    }

    // ----- Services + ServicePricingTier + AvailabilityWindow -----
    // Upsert by (organizationId, slug). On first insert we also seed tiers
    // and per-service availability windows. On a re-crawl we never touch
    // an existing service's tiers / windows so the operator's manual edits
    // are preserved — the crawler is "fill the blanks", not "overwrite."
    const VALID_PRICE_UNITS = new Set(['flat', 'per_hour', 'per_day', 'per_session', 'per_unit']);
    const VALID_DAYS = new Set([
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    ]);
    const parseMinor = (p: unknown): number | null => {
      if (p == null) return null;
      const n = typeof p === 'number' ? p : Number(String(p).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 100);
    };
    const parseTime = (t: string | null | undefined): number | null => {
      if (!t) return null;
      const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
      if (!m) return null;
      const h = Number(m[1]);
      const mn = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
      if (h < 0 || h > 24 || mn < 0 || mn > 59) return null;
      return h * 60 + mn;
    };
    const slugifyService = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100);

    for (const svc of (extracted!.services ?? []).slice(0, 30)) {
      const name = svc.name?.trim().slice(0, 200);
      if (!name) continue;
      const slug = slugifyService(name);
      if (!slug) continue;

      const baseCurrency =
        svc.currency?.trim().toUpperCase().slice(0, 3) || null;
      const currency = baseCurrency && /^[A-Z]{3}$/.test(baseCurrency) ? baseCurrency : 'USD';
      const priceUnit =
        svc.priceUnit && VALID_PRICE_UNITS.has(svc.priceUnit.toLowerCase())
          ? (svc.priceUnit.toLowerCase() as 'flat' | 'per_hour' | 'per_day' | 'per_session' | 'per_unit')
          : 'flat';
      const basePriceMinor = parseMinor(svc.basePrice ?? null);
      const durationMinutes =
        typeof svc.durationMinutes === 'number' && svc.durationMinutes > 0 && svc.durationMinutes < 60 * 24
          ? Math.round(svc.durationMinutes)
          : null;
      const description = svc.description?.trim().slice(0, 4000) || null;
      const shortDescription = svc.shortDescription?.trim().slice(0, 200) || null;

      // Upsert by slug. Existing row → only fill currently-null fields so
      // operator edits win, matching the businessInfo policy above.
      const existing = await tx.service.findFirst({
        where: { organizationId, slug },
        select: { id: true, description: true, shortDescription: true, durationMinutes: true, basePriceMinor: true },
      });

      let serviceId: string;
      if (existing) {
        const data: Record<string, unknown> = {};
        if (description && !existing.description) data.description = description;
        if (shortDescription && !existing.shortDescription) data.shortDescription = shortDescription;
        if (durationMinutes && !existing.durationMinutes) data.durationMinutes = durationMinutes;
        if (basePriceMinor != null && existing.basePriceMinor == null) {
          data.basePriceMinor = basePriceMinor;
          data.currency = currency;
          data.priceUnit = priceUnit;
        }
        if (Object.keys(data).length > 0) {
          await tx.service.update({ where: { id: existing.id }, data });
        }
        serviceId = existing.id;
      } else {
        const created = await tx.service.create({
          data: {
            organizationId,
            slug,
            name,
            description,
            shortDescription,
            durationMinutes,
            basePriceMinor,
            currency,
            priceUnit,
          },
          select: { id: true },
        });
        serviceId = created.id;
      }

      // Tiers + availability — only seed when this service has zero rows
      // of each, so a re-crawl doesn't duplicate or clobber operator edits.
      if (Array.isArray(svc.tiers) && svc.tiers.length > 0) {
        const tierCount = await tx.servicePricingTier.count({ where: { serviceId } });
        if (tierCount === 0) {
          let sortOrder = 0;
          for (const t of svc.tiers.slice(0, 10)) {
            const tName = t.name?.trim().slice(0, 100);
            const priceMinor = parseMinor(t.price ?? null);
            if (!tName || priceMinor == null) continue;
            const tCurrencyRaw = t.currency?.trim().toUpperCase().slice(0, 3) || null;
            const tCurrency = tCurrencyRaw && /^[A-Z]{3}$/.test(tCurrencyRaw) ? tCurrencyRaw : currency;
            const features = Array.isArray(t.features)
              ? t.features
                  .filter((f): f is string => typeof f === 'string')
                  .map((f) => f.trim().slice(0, 200))
                  .filter((f) => f.length > 0)
                  .slice(0, 20)
              : [];
            await tx.servicePricingTier.create({
              data: {
                organizationId,
                serviceId,
                name: tName,
                description: t.description?.trim().slice(0, 1000) || null,
                priceMinor,
                currency: tCurrency,
                priceUnit,
                sortOrder,
                features,
              },
            });
            sortOrder += 1;
          }
        }
      }

      if (Array.isArray(svc.availability) && svc.availability.length > 0) {
        const windowCount = await tx.availabilityWindow.count({ where: { serviceId } });
        if (windowCount === 0) {
          for (const w of svc.availability.slice(0, 14)) {
            const day = w.dayOfWeek?.toLowerCase().trim();
            if (!day || !VALID_DAYS.has(day)) continue;
            const startMinute = parseTime(w.startTime);
            const endMinute = parseTime(w.endTime);
            if (startMinute == null || endMinute == null || endMinute <= startMinute) continue;
            await tx.availabilityWindow.create({
              data: {
                organizationId,
                serviceId,
                dayOfWeek: day as 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
                startMinute,
                endMinute,
              },
            });
          }
        }
      }
    }

    // ----- Policies (one per kind — only insert if no row exists for that kind) -----
    for (const p of (extracted!.policies ?? []).slice(0, 8)) {
      if (!p.kind || !p.content) continue;
      const kind = p.kind.toLowerCase().trim().slice(0, 32);
      const content = p.content.trim().slice(0, 8000);
      const title = p.title?.trim().slice(0, 200) || `${kind.charAt(0).toUpperCase() + kind.slice(1)} policy`;
      if (!content) continue;
      const dupe = await tx.policy.findFirst({
        where: { organizationId, kind },
        select: { id: true },
      });
      if (dupe) continue;
      await tx.policy.create({
        data: { organizationId, kind, title, content },
      });
    }
  });
}

// Per-image hard caps. Anything outside these is rejected without
// hitting the DB. Numbers chosen to cover product photography on typical
// e-commerce / real-estate sites (Unsplash hero shots, ~2-4 MB JPEGs)
// without giving a malicious server a 100-MB SSRF amplifier.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

// Fetch the chosen image, upload it to Wasabi, and attach it to the
// product as the primary ProductImage. Bails out cleanly on any
// validation failure (bad URL, wrong content-type, too large, network
// timeout). Storage / DB writes are atomic-enough: if the Asset row
// commits but the Wasabi PUT fails, we already PUT before the row.
async function downloadAndAttachImage(
  organizationId: string,
  job: { productId: string; imageUrl: string; alt: string },
): Promise<void> {
  if (!env.WASABI_ACCESS_KEY_ID || !env.WASABI_SECRET_ACCESS_KEY) {
    // Object storage isn't wired up — skip silently so dev-mode crawls
    // still produce products, just without thumbnails.
    return;
  }

  // SSRF guard. The image URL came from a third-party page, so re-validate +
  // pin the connection IP and re-check every redirect hop before we make
  // ANOTHER outbound request.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let res: SafeResponse;
  try {
    res = await safeFetch(job.imageUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)' +
          ' Chrome/120.0.0.0 Safari/537.36 the platformBot/1.0 (+https://example.com/bot)',
        Accept: 'image/*',
      },
    });
  } catch (err) {
    if (err instanceof UrlGuardError) return; // blocked/private/redirect-to-private — skip
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) return;

  // Trust Content-Type when present; otherwise fall back to a tiny
  // magic-number sniff after we have the bytes.
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (headerType && !ALLOWED_IMAGE_TYPES.has(headerType)) return;

  // Stream the body with a hard byte cap so a 5-GB pseudo-image can't
  // OOM the worker.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of res.body) {
    if (!value) continue;
    const buf = Buffer.from(value);
    total += buf.byteLength;
    if (total > IMAGE_MAX_BYTES) {
      res.body.destroy();
      return;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks, total);
  if (body.byteLength < 1024) return; // skip 1x1 pixels / icons

  // Sniff magic-number if Content-Type was missing.
  const contentType = headerType || sniffImageContentType(body);
  if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) return;

  // Build the same storage-key shape the API uses: org/<orgId>/image/<yyyy>/<mm>/<assetId>.<ext>
  const { randomUUID } = await import('node:crypto');
  const assetId = randomUUID();
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = extensionForContentType(contentType);
  const storageKey = `org/${organizationId}/image/${yyyy}/${mm}/${assetId}${ext}`;

  await putObject({ storageKey, body, contentType });

  await withRlsBypass(async (tx) => {
    // Re-check the product wasn't deleted or already picked up an image
    // in the seconds since we queued this download.
    const product = await tx.product.findUnique({
      where: { id: job.productId },
      select: { id: true, deletedAt: true },
    });
    if (!product || product.deletedAt) return;
    const existing = await tx.productImage.findFirst({
      where: { productId: product.id },
      select: { id: true },
    });
    if (existing) return;

    const asset = await tx.asset.create({
      data: {
        id: assetId,
        organizationId,
        kind: 'image',
        storageKey,
        contentType,
        byteSize: body.byteLength,
        metadata: { source: 'crawl', sourceUrl: job.imageUrl },
      },
      select: { id: true },
    });
    await tx.productImage.create({
      data: {
        organizationId,
        productId: product.id,
        assetId: asset.id,
        altText: job.alt || null,
        sortOrder: 0,
        isPrimary: true,
      },
    });
  });
}

function sniffImageContentType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png':  return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif':  return '.gif';
    case 'image/avif': return '.avif';
    default: return '';
  }
}

// Wrapper kept so the second-pass (post-BFS) call can still operate on
// the full corpus in case any listing-shaped pages slipped through the
// inline path (e.g. an LLM blip at the moment we crawled the page).
// Pages whose URL is in `alreadyHandled` are skipped — the inline pass
// already succeeded for them, so re-running the LLM would just double-
// bill the fallback provider for an idempotent upsert. Drop the set to
// process every listing-shaped page (the historical behaviour).
async function extractAndPersistListings(
  organizationId: string,
  crawlJobId: string,
  corpus: CorpusPage[],
  alreadyHandled?: Set<string>,
): Promise<number> {
  const listingPages = corpus.filter(
    (p) => looksLikeListingPage(p.text) && !alreadyHandled?.has(p.url),
  );
  if (listingPages.length === 0) return 0;
  let total = 0;
  for (const page of listingPages) {
    total += await extractListingsFromPage(organizationId, crawlJobId, page);
  }
  return total;
}
