import emailjs from '@emailjs/browser';

const SERVICE_ID  = process.env.REACT_APP_EMAILJS_SERVICE_ID  ?? '';
const TEMPLATE_ID = process.env.REACT_APP_EMAILJS_TEMPLATE_ID ?? '';
const PUBLIC_KEY  = process.env.REACT_APP_EMAILJS_PUBLIC_KEY  ?? '';

const TO_EMAIL = 'donada.cnft@gmail.com';

type EventType = 'Rental Listing' | 'Rental Confirmed';

interface NotifyParams {
  eventType: EventType;
  subject:   string;
  details:   string;
}

async function sendNotification({ eventType, subject, details }: NotifyParams): Promise<void> {
  if (!SERVICE_ID || !TEMPLATE_ID || !PUBLIC_KEY) return;
  try {
    await emailjs.send(
      SERVICE_ID,
      TEMPLATE_ID,
      {
        to_email:   TO_EMAIL,
        event_type: eventType,
        subject,
        details,
      },
      { publicKey: PUBLIC_KEY },
    );
  } catch (err) {
    console.warn('EmailJS notification failed:', err);
  }
}

export function notifyListingCreated(params: {
  nftName: string;
  price:   string;
  owner:   string;
  txHash:  string;
}): Promise<void> {
  return sendNotification({
    eventType: 'Rental Listing',
    subject:   `New Listing: ${params.nftName}`,
    details: [
      `NFT:    ${params.nftName}`,
      `Price:  ₳${params.price}`,
      `Owner:  ${params.owner}`,
      `Tx:     ${params.txHash}`,
    ].join('\n'),
  });
}

export function notifyRentalConfirmed(params: {
  nftName: string;
  fee:     string;
  renter:  string;
  owner:   string;
  txHash:  string;
}): Promise<void> {
  return sendNotification({
    eventType: 'Rental Confirmed',
    subject:   `NFT Rented: ${params.nftName}`,
    details: [
      `NFT:    ${params.nftName}`,
      `Fee:    ₳${params.fee}`,
      `Renter: ${params.renter}`,
      `Owner:  ${params.owner}`,
      `Tx:     ${params.txHash}`,
    ].join('\n'),
  });
}
