# PostgreSQL Custom

Stores every new listing in PostgreSQL together with its provider payload and downloaded media.

- `raw_response` is JSON for API providers. HTML providers store the listing/detail HTML as a
  string inside the JSON wrapper.
- `images` and `attachments` are JSON arrays containing source URLs, local paths, hashes and
  download status.
- Media is written below the configured media directory. Mount that directory as persistent
  storage when Fredy runs in a container.
- Provider detail responses and complete galleries are available only for providers enabled in
  the user's provider-details setting.

Individual media download failures are recorded in PostgreSQL and do not prevent the listing row
from being stored.
