# Keptra monetization and marketing plan

Date: 2026-04-30

## Short answer

Yes, Keptra is marketable, but the best wedge is not "AI photo culling" in the broad sense. That market is crowded by Aftershoot, Narrative Select, FilterPixel, Evoto, Photo Mechanic, and smaller mobile tools.

Keptra's sharper position is:

> The offline card-to-drive import and culling tool for photographers who want the Lightroom import workflow back without renting Lightroom.

That is specific, emotionally clear, and already matches the product: camera/SD detection, keyboard culling, protected-file priority, local AI, checksummed import, backup mirror, FTP/NAS support, and no cloud uploads.

## Current commercial assets

Keptra already has:

- A public marketing site at `web/index.html`.
- Download and checkout pages.
- Stripe checkout plumbing through the hosted update/admin service.
- Offline signed license keys.
- Free/Pro gating inside the product.
- Trial support.
- Device-seat pricing.
- Mac and Windows release artifacts.

That means the next milestone is not "invent monetization." It is tightening the offer, testing demand, and shipping small campaigns.

## Recommended offer

### Primary offer

Use a simple freemium model:

- Free: unlimited browse/review/import basics for 1 device.
- Pro: paid features that matter when someone is saving serious time or protecting paid work.

Keep Free genuinely useful. The app should earn trust before asking for money.

### Pro features to gate

Best Pro gates:

- Local face review and sharpness scoring.
- Burst auto-pick.
- Auto-import on card insert.
- Backup destination.
- FTP/NAS mirror output.
- Exposure normalization / output conversion.
- Priority support.

Avoid gating core trust features like basic import, duplicate detection, and checksum verification. Those make the app feel reliable.

## Pricing recommendation

The live pricing API currently returns:

- Monthly: AUD $5/mo
- Yearly: AUD $40/yr
- Lifetime: AUD $49 one-time
- Extra device: AUD $5 one-time
- Trial: 7 days

That is low enough to reduce friction, but the lifetime plan is too close to yearly. It may cap revenue from serious users.

Recommended test:

- Monthly: AUD $7/mo
- Yearly: AUD $49/yr
- Lifetime: AUD $89 launch price, later AUD $129
- Extra device: AUD $9 once
- Trial: 14 days

Why:

- AUD $49/year is still comfortably below many pro photo workflow tools.
- Lifetime should feel like a commitment, not an obvious substitute for yearly.
- A 14-day trial better matches photographers who may only shoot weekly.
- "Launch lifetime price" creates urgency without fake scarcity.

## Best customer segments

### 1. Lightroom quitters

People who canceled Adobe but miss Lightroom Classic's import flow.

Message:

> Keep the fast card import workflow. Skip the Lightroom subscription.

Where to find them:

- Reddit: `r/Lightroom`, `r/AskPhotography`, `r/macapps`, `r/photography`.
- YouTube comments on Lightroom alternatives.
- Indie software communities.
- Search content around "Lightroom import alternative", "cull before importing Lightroom", "photo culling from SD card".

### 2. Event and school photographers

They need fast ingest, duplicate skipping, basic culling, and safe copy verification.

Message:

> Card in, keepers out, two verified copies on disk.

Best hooks:

- Keyboard-first speed.
- Checksums.
- Backup destination.
- Burst grouping.
- No cloud upload.

### 3. Sports and action shooters

They produce bursts and need quick best-frame selection.

Message:

> Collapse bursts, pick the sharpest frame, move on.

Best hooks:

- Burst grouping.
- Shift+B auto-pick.
- Protected-first workflow.
- Fast local review.

### 4. Privacy-conscious family/documentary photographers

They may not be professionals, but they care about photos staying local.

Message:

> AI help for your photos, without uploading your life.

Best hooks:

- Offline/local AI.
- No cloud.
- One-time license option.

## Positioning

### One-liner

Keptra is a fast, offline photo import and culling app for Mac and Windows.

### Homepage headline options

1. Culling that gets out of your way
2. Import only the keepers
3. The card-to-drive workflow Lightroom forgot
4. Fast photo import without the subscription
5. Cull, verify, and import before Lightroom ever opens

Best current choice:

> Import only the keepers

It is more concrete than "Culling that gets out of your way" and speaks to the outcome.

### Subheadline

Plug in a camera card, fly through picks with the keyboard, and copy only the shots you want into clean date-based folders. Keptra runs locally, checks every copy, and never uploads your photos.

### Main proof points

- No cloud uploads.
- Mac and Windows.
- Keyboard-first culling.
- Checksummed imports.
- Backup mirror.
- Local AI review.
- Works with SD cards, cameras, folders, and FTP/NAS sources.

## Competitive angle

Do not try to beat Aftershoot at "AI edits your whole wedding." Do not try to beat Photo Mechanic at newsroom metadata power.

Keptra should win on:

- Offline local workflow.
- Lightweight pre-import culling.
- Import safety.
- No subscription lock-in.
- Simple ownership.
- Practical tools for getting files off cards cleanly.

Competitor-aware copy:

> AI culling tools can choose for you. Lightroom can organize after import. Keptra sits before both: it helps you decide what deserves to land on disk in the first place.

## Channels to launch

### Highest priority

1. Product Hunt
2. Reddit soft launch
3. YouTube demo shorts
4. SEO pages
5. Photography Facebook groups, used carefully
6. Indie Hackers / Hacker News Show HN

### SEO pages to add

Create one page for each:

- `/lightroom-import-alternative.html`
- `/photo-culling-before-import.html`
- `/sd-card-photo-importer.html`
- `/offline-ai-photo-culling.html`
- `/photo-mechanic-alternative-for-import.html`

Each page should be useful, not just sales copy. Include workflow screenshots and answer the exact search intent.

## Launch copy

### Product Hunt tagline

Fast offline photo culling and import for Mac and Windows.

### Product Hunt description

Keptra helps photographers review a camera card before importing everything. Plug in an SD card, cull with keyboard shortcuts, pick the best burst frames, skip duplicates, and copy only the keepers into organized folders with checksum verification. Local AI assists with sharpness and face review, but nothing leaves your machine.

### Reddit post draft

Title:

I built the Lightroom import workflow I missed after canceling Adobe

Post:

I canceled Adobe, then realized the part I missed most was not editing. It was the boring but useful import workflow: plug in a card, review fast, pick/reject, copy into date folders, avoid duplicates, and keep the card-to-drive step clean.

So I built Keptra for Mac and Windows. It lets you cull before import, use P/X/1-5 keyboard shortcuts, group bursts, skip duplicates, checksum copied files, and optionally run local AI sharpness/face review. No cloud upload.

There is a free version and a Pro trial. I would genuinely love workflow feedback from photographers, especially anyone who culls from SD cards before opening Lightroom/Capture One/etc.

Link: https://keptra.z2hs.au/

### X / Threads posts

1.

I canceled Adobe and accidentally built the Lightroom import tool I missed.

Keptra lets you plug in a card, cull with the keyboard, skip duplicates, checksum copies, and import only the keepers.

Mac + Windows. No cloud uploads.

2.

Most photo tools start after everything is already imported.

Keptra starts at the card.

Review, pick, reject, group bursts, copy safely, and land files in clean folders before your editor opens.

3.

For photographers who shoot bursts: Keptra stacks near-duplicates, shows sharpness scores, and lets you pick the best frame without dragging a whole sequence into your library.

### YouTube short script

Hook:

I canceled Lightroom, but I missed one thing: the import screen.

Demo beats:

1. Insert SD card.
2. Keptra detects it.
3. Tap P/X and arrow keys through images.
4. Show burst stack and Shift+B.
5. Show import summary with checksum verified.
6. End on organized date folders.

CTA:

Keptra is free to try on Mac and Windows.

## Landing page changes to test

1. Change the hero headline from "Culling that gets out of your way" to "Import only the keepers."
2. Move "checksummed import" and "backup mirror" higher. Safety is a stronger trust signal than GPU diagnostics.
3. Replace "No subscriptions" with "No subscription required" because a monthly plan exists.
4. Show the live price immediately if the API fails. Current fallback says 14-day trial while live API says 7 days, which creates trust drift.
5. Add a simple comparison strip:
   - Lightroom: import-first catalog workflow
- AI culling tools: selection/editing automation
   - Keptra: pre-import culling and verified card copy
6. Add a "Who this is for" section:
   - Adobe quitters
   - Event shooters
   - Sports/action shooters
   - Privacy-first photographers

## Metrics to track

Minimum viable analytics:

- Download clicks.
- Installer downloads by platform.
- Trial starts.
- Trial activation success.
- Trial-to-paid conversion.
- Checkout started.
- Checkout completed.
- Free-to-Pro upgrade source.
- Which plan is chosen.
- First import completed.
- Number of photos imported in first session.

Activation milestone:

> User imports at least 50 photos or completes one card import with checksum verification.

That is the real "aha" moment.

## 30-day launch plan

### Week 1: tighten the funnel

- Align trial wording across app/site/API.
- Raise or test lifetime pricing.
- Add first SEO page: Lightroom import alternative.
- Add basic event tracking.
- Record one 45-second demo.

### Week 2: soft launch

- Post to one relevant subreddit asking for feedback, not sales.
- Share the demo on X/Threads/YouTube Shorts.
- Ask 5 photographers directly to try one import.
- Capture objections and confusing moments.

### Week 3: improve conversion

- Fix the top 3 onboarding issues.
- Add testimonials or direct quotes if users provide permission.
- Add comparison section to homepage.
- Add a "privacy/local AI" page.

### Week 4: broader launch

- Product Hunt launch.
- Show HN launch if the story is framed as local-first indie software.
- Outreach to small photography YouTubers.
- Publish "How to cull before importing into Lightroom/Capture One" article.

## Risks

- Trust: photo import is sensitive. Any data-loss bug can sink adoption. Keep checksum verification, copy logs, and non-destructive defaults front and center.
- Positioning sprawl: "AI culling, import, backup, FTP, exposure, GPU" can sound unfocused. Lead with one job: card-to-drive keeper import.
- Pricing confusion: monthly/yearly/lifetime/free/trial must be consistent across site, app, and checkout.
- Code signing: Windows SmartScreen and macOS Gatekeeper warnings reduce trust. Signing is a high-value investment before broad paid acquisition.

## Next best actions

1. Make the landing page say "Import only the keepers."
2. Align trial duration to 14 days everywhere, or make the site reflect the live 7-day trial.
3. Add one SEO landing page for Lightroom quitters.
4. Ship the Reddit soft-launch post.
5. Track downloads and trial starts before spending money on ads.
