# Up NEPA

Live, crowd-verified power status for every part of Lagos (139 neighbourhoods across all 20 LGAs).

## Go live (about 5 minutes)

1. **Turn on anonymous sign-ins.** In the Supabase dashboard, open project `up-nepa` (Ysidra org), then Authentication → Sign In / Providers → enable **Allow anonymous sign-ins**. Without this, people can view status but not report.
2. **Deploy.** Push this folder to a GitHub repo, then import it in Vercel. There is no build step: framework preset "Other", output directory = root.
3. Open the site on your phone, allow location, and tap a button. Done.

## How accuracy works

- Each phone gets an anonymous account, so **one phone = one vote per area** (only its latest report in 6 hours counts).
- The server checks GPS: reports from more than 6km away are rejected; within 3.5km with good GPS they are **verified** (full weight), otherwise 0.4 weight.
- Reports lose half their weight every hour.
- **Confirmed** = 3+ verified neighbours, 75%+ agreement. **Mixed** = under 65% agreement.
- Rate limits: one report per area every 2 minutes, 20 per hour per phone.
- Exact coordinates are never stored; only distance to the area centre.

## Posting official notices

Add a row to the `notices` table in the Supabase Table Editor (title, body, source_name, source_url, scope, expires_at). It appears in every open app instantly.

## Scale

- Raw reports are never exposed; the app reads summaries through `area_status`, `area_pattern` and `area_log`.
- Realtime only sends a tiny "area updated" ping; clients refetch status at most once every 1.2s.
- App shell is cached by a service worker, so it opens instantly on slow networks.
- If traffic grows past a few thousand active users, add a materialized view refreshed every 30s for `area_status`.

## Notes

- Area centres are approximate; edit `areas` lat/lng in Supabase to refine.
- Map tiles come from OpenStreetMap; for heavy traffic, switch to a paid tile provider (MapTiler, Stadia).
