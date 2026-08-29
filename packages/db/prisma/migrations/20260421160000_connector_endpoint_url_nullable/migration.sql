-- A connector is valid with only an endpointUrl (pull) OR only an inbound
-- webhook secret (push). Webhook-only connectors have no endpointUrl.
ALTER TABLE "api_connectors" ALTER COLUMN "endpoint_url" DROP NOT NULL;
