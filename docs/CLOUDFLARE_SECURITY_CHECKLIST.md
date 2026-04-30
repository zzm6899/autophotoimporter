# Cloudflare security checklist

Use this when publishing Keptra downloads from the public website while keeping the repository private.

## DNS

- Put `updates.keptra.z2hs.au` behind the orange-cloud Cloudflare proxy.
- Put `admin.keptra.z2hs.au` behind the orange-cloud Cloudflare proxy.
- Avoid exposing the TrueNAS/origin IP in public DNS. A proxied record should resolve to Cloudflare IP ranges, not the server's direct IP.
- If possible, firewall the origin so ports 80 and 443 only accept Cloudflare IP ranges.

## SSL/TLS

- Set Cloudflare SSL/TLS mode to **Full (strict)**.
- Use a valid origin certificate on Caddy. Either:
  - Let Caddy manage public certificates, or
  - Install a Cloudflare Origin Certificate and configure Caddy to use it.
- Enable **Always Use HTTPS**.
- Enable **Automatic HTTPS Rewrites**.
- Keep HSTS enabled at the origin. The Caddyfile sends:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`

## WAF and access control

- Add a Cloudflare WAF rule or Zero Trust Access policy for `admin.keptra.z2hs.au/*`.
- Keep `updates.keptra.z2hs.au` public for downloads and API endpoints.
- Add bot/challenge rules for:
  - `/admin/*`
  - `/api/v1/checkout/create`
  - `/stripe/webhook/test`
- Do not challenge the real Stripe webhook path:
  - `/stripe/webhook`

## Security headers

The origin Caddyfile now sends:

- `Strict-Transport-Security`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `Referrer-Policy`
- `Permissions-Policy`
- `Content-Security-Policy`

It also strips `X-Powered-By`.

## Downloads

- Use signed Windows and macOS builds when possible.
- Publish SHA-256 checksums beside every installer.
- Consider linking a VirusTotal scan for the Windows installer.
- Keep downloadable artifacts under `/artifacts/*`; avoid exposing source archives from the private repo.

## Quick verification

After deployment, run:

```powershell
Invoke-WebRequest -Uri "https://updates.keptra.z2hs.au/" -Method Head | Select-Object -ExpandProperty Headers
Resolve-DnsName updates.keptra.z2hs.au -Type A
```

Expected:

- Security headers are present.
- `X-Powered-By` is absent.
- DNS returns Cloudflare IPs, not the TrueNAS/origin IP.
