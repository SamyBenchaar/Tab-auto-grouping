// Privacy policy page (public/privacy.html), with the contact taken from PRIVACY_CONTACT.
import { readFileSync } from 'node:fs';

const TEMPLATE = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
const FALLBACK = {
  fr: 'l’adresse de contact indiquée sur la fiche Chrome Web Store de l’extension',
  en: 'the contact address shown on the extension’s Chrome Web Store listing',
};

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function contactHtml(contact, fallback) {
  if (!contact) return fallback;
  const text = escapeHtml(contact);
  if (/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(contact)) return `<a href="mailto:${text}">${text}</a>`;
  if (/^https:\/\/[^\s<>"']+$/.test(contact)) return `<a href="${text}">${text}</a>`;
  return text;
}

export function renderPrivacyPage(config) {
  return TEMPLATE.replaceAll('{{CONTACT_FR}}', contactHtml(config.privacyContact, FALLBACK.fr)).replaceAll(
    '{{CONTACT_EN}}',
    contactHtml(config.privacyContact, FALLBACK.en),
  );
}
