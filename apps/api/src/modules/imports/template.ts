// Generates downloadable XLSX import templates per entity kind, with
// header row, sample data row, and a column mapping cheat-sheet on a second sheet.
import type { ImportEntityKind, ImportFieldHint } from '@platform/shared';
import ExcelJS from 'exceljs';

interface TemplateSpec {
  fields: ImportFieldHint[];
  sample: Record<string, string | number | boolean>;
}

export const TEMPLATES: Record<ImportEntityKind, TemplateSpec> = {
  product: {
    fields: [
      { field: 'sku', label: 'SKU', required: true, description: 'Unique identifier per product' },
      { field: 'name', label: 'Name', required: true, description: 'Display name' },
      { field: 'shortDescription', label: 'Short description', required: false },
      { field: 'description', label: 'Description', required: false, description: 'Long-form, markdown OK' },
      {
        field: 'priceMinor',
        label: 'Price',
        required: false,
        description:
          'Whole number in your shop currency’s smallest unit. ×100 for USD/EUR/AED (1999 = 19.99); ×1000 for KWD/BHD/OMR/JOD (1500 = 1.500 KD). Leave blank to set later.',
      },
      {
        field: 'currency',
        label: 'Currency',
        required: false,
        description: '3-letter ISO (USD, KWD, LBP…). Leave blank to use your shop’s default currency.',
      },
      { field: 'isAvailable', label: 'Available', required: false, description: 'true / false (blank = available)' },
      { field: 'stockQuantity', label: 'Stock', required: false },
      { field: 'categorySlug', label: 'Category slug', required: false, description: 'e.g. "burgers" — created automatically if it doesn’t exist' },
      {
        field: 'imageUrls',
        label: 'Image URLs',
        required: false,
        description:
          'Public image links, comma-separated. They’re downloaded and attached on import (first = main photo). Max 6 per product. Only applied when the product has no images yet.',
      },
    ],
    sample: {
      sku: 'WIDGET-001',
      name: 'Premium Widget',
      shortDescription: 'A premium widget for everyday use',
      description: 'Long description here.',
      priceMinor: 1999,
      currency: 'USD',
      isAvailable: true,
      stockQuantity: 50,
      categorySlug: 'widgets',
      imageUrls: 'https://example.com/widget-front.jpg, https://example.com/widget-side.jpg',
    },
  },
  service: {
    fields: [
      { field: 'name', label: 'Name', required: true },
      { field: 'shortDescription', label: 'Short description', required: false },
      { field: 'description', label: 'Description', required: false },
      { field: 'durationMinutes', label: 'Duration (minutes)', required: false },
      {
        field: 'basePriceMinor',
        label: 'Base price',
        required: false,
        description:
          'Whole number in your shop currency’s smallest unit. ×100 for USD/EUR/AED (5000 = 50.00); ×1000 for KWD/BHD/OMR/JOD.',
      },
      { field: 'currency', label: 'Currency', required: false, description: '3-letter ISO. Blank = shop default.' },
      {
        field: 'priceUnit',
        label: 'Price unit',
        required: false,
        description: 'flat | per_hour | per_day | per_session | per_unit',
      },
      { field: 'isAvailable', label: 'Available', required: false },
      { field: 'categorySlug', label: 'Category slug', required: false },
    ],
    sample: {
      name: 'Consulting session',
      shortDescription: '30-minute consult',
      description: 'A 30-minute strategy session.',
      durationMinutes: 30,
      basePriceMinor: 5000,
      currency: 'USD',
      priceUnit: 'flat',
      isAvailable: true,
      categorySlug: 'consulting',
    },
  },
  faq: {
    fields: [
      { field: 'question', label: 'Question', required: true },
      { field: 'answer', label: 'Answer', required: true },
      { field: 'visibility', label: 'Visibility', required: false, description: 'public | private (default: public)' },
      { field: 'tags', label: 'Tags', required: false, description: 'Comma-separated' },
    ],
    sample: {
      question: 'What is your return policy?',
      answer: 'You may return any item within 30 days of purchase.',
      visibility: 'public',
      tags: 'returns, policy',
    },
  },
  business_info: {
    fields: [
      { field: 'legalName', label: 'Legal name', required: false },
      { field: 'tagline', label: 'Tagline', required: false },
      { field: 'about', label: 'About', required: false },
      { field: 'websiteUrl', label: 'Website URL', required: false },
      { field: 'timezone', label: 'Timezone', required: false },
      { field: 'currency', label: 'Currency', required: false },
    ],
    sample: {
      legalName: 'Aligned Demo, Inc.',
      tagline: 'Aligning technology with your business',
      about: 'A short business description.',
      websiteUrl: 'https://aligned.example',
      timezone: 'UTC',
      currency: 'USD',
    },
  },
};

export async function buildTemplateXlsx(kind: ImportEntityKind): Promise<Buffer> {
  const spec = TEMPLATES[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ALIGNED Business Platform';
  wb.created = new Date();

  const sheet = wb.addWorksheet(kind);
  sheet.columns = spec.fields.map((f) => ({
    // IMPORTANT: the header text must stay the plain label — the import worker
    // normalizes headers ("Short description" → short_description) to map
    // columns to fields. Required/optional is conveyed via colour + a cell
    // comment, NOT by changing the header text.
    header: f.label,
    key: f.field,
    width: Math.max(16, f.label.length + 4),
  }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };
  spec.fields.forEach((f, i) => {
    const cell = headerRow.getCell(i + 1);
    // Required = amber fill; optional = light grey. Plus a hover comment that
    // spells out "Required"/"Optional" and the field's help text.
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: f.required ? 'FFF6C453' : 'FFEDEDED' },
    };
    cell.note = `${f.required ? '✱ REQUIRED' : 'Optional'}${f.description ? `\n${f.description}` : ''}`;
  });
  // Sample row.
  sheet.addRow(spec.sample);

  // Help sheet — legend + per-field Required/Optional + descriptions.
  const help = wb.addWorksheet('How to import');
  help.columns = [
    { header: 'Field', key: 'field', width: 22 },
    { header: 'Required?', key: 'required', width: 12 },
    { header: 'Description', key: 'description', width: 70 },
  ];
  help.getRow(1).font = { bold: true };
  // Intro / legend rows.
  const notes = [
    { field: '— LEGEND —', required: '', description: 'Amber header = REQUIRED. Grey header = optional. Hover any header cell for its note.' },
    { field: 'Required', required: '✱', description: 'You MUST fill this in every row, or the row is skipped.' },
    { field: 'Optional', required: '', description: 'Leave blank to skip; sensible defaults apply.' },
    { field: '', required: '', description: '' },
  ];
  for (const n of notes) help.addRow(n);
  for (const f of spec.fields) {
    help.addRow({
      field: f.field,
      required: f.required ? '✱ Required' : 'Optional',
      description: f.description ?? '',
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
