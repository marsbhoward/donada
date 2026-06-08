# Environment Setup

## Local Development

Create a `.env` file in the project root (never commit this file):

```
REACT_APP_BlockFrost_API_KEY_Preview=your_blockfrost_preview_key
REACT_APP_BlockFrost_API_KEY_Mainnet=your_blockfrost_mainnet_key
BLOCKFROST_IPFS_KEY=your_blockfrost_ipfs_key
REACT_APP_EMAILJS_SERVICE_ID=your_emailjs_service_id
REACT_APP_EMAILJS_TEMPLATE_ID=your_emailjs_template_id
REACT_APP_EMAILJS_PUBLIC_KEY=your_emailjs_public_key
OWNER_SEED_PHRASE="your 24 word seed phrase"
PRIZE_LOVELACE=your_prize_amount_in_lovelace
```

## GitHub Actions Secrets

The draw script runs via GitHub Actions. Add the following secrets at:
**Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Description |
|---|---|
| `OWNER_SEED_PHRASE` | 24-word seed phrase for the project wallet |
| `BLOCKFROST_API_KEY_PREVIEW` | Blockfrost Preview network API key |
| `BLOCKFROST_API_KEY_MAINNET` | Blockfrost Mainnet API key |
| `PRIZE_LOVELACE` | Prize amount in lovelace (1 ADA = 1,000,000 lovelace) |
| `EMAILJS_SERVICE_ID` | EmailJS service ID |
| `EMAILJS_TEMPLATE_ID` | EmailJS template ID |
| `EMAILJS_PUBLIC_KEY` | EmailJS public key |

## EmailJS Template

Create a template at [emailjs.com](https://emailjs.com) with the following variables:

- `{{to_email}}` — recipient address
- `{{subject}}` — email subject line
- `{{event_type}}` — event type (e.g. "Draw Complete", "Rental Listing")
- `{{details}}` — body content with event details
