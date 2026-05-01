# Keptra Release Notes

Version:
Release date:
Channel: stable
Platform focus: Windows installed app

## Summary
- 

## Update Safety
- Client update fixes: Yes/No
- Server update fixes: Yes/No
- Legacy Culler endpoint compatibility: Yes/No
- Installer/download changes: Yes/No

## License Impact
- License schema changes: No
- Existing `licenseKey` persistence: Preserved
- Existing `licenseActivationCode` persistence: Preserved
- Existing `licenseStatus` persistence: Preserved

## Workflow Changes
- 

## Import/Export Changes
- 

## Smoke Checklist
- `npm run verify`
- `npm run release:smoke`
- Windows installed `1.4.0 -> latest`: update check finds latest, download starts, installer launches.
- License remains saved after update.
- Settings remain saved after update.
- Live endpoints checked:
  - `https://keptra.z2hs.au/api/v1/app/update?platform=windows&version=1.4.0&channel=stable`
  - `https://updates.keptra.z2hs.au/api/v1/app/update?platform=windows&version=1.4.0&channel=stable`
  - `https://updates.culler.z2hs.au/api/v1/app/update?platform=windows&version=1.4.0&channel=stable`

## Rollback Notes
- 
