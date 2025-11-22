# Zendesk Email Normalizer & Safe User Merger

Automation for normalizing **customer emails in Zendesk**, adding them as verified primary identities, and safely **merging duplicate users** – with special handling for Instagram accounts.

## Problem

- Same customer contacts via **WhatsApp, Email, Instagram**, etc.
- Zendesk creates multiple end-user records
- Identities are fragmented, primary emails are wrong
- Risky merges can break Instagram profiles

## Solution

Google Apps Script webhook that:

1. Parses email addresses from the latest ticket comment text
2. Searches Zendesk for existing users with that email
3. If no owner:
   - Adds email identity to the current requester
   - Verifies it and makes it primary
4. If another user owns that email:
   - If **owner is Instagram user** → merge requester → owner  
   - If **requester is Instagram** → merge owner → requester  
   - Else → default: email owner survives
5. After merge: ensures email is **verified & primary** on survivor user

## Tech Stack

- Google Apps Script
- Zendesk Users, Search, Identities, Merge APIs

## Core Logic

- Extract email: regex over comment transcript
- `type:user email:<email>` search
- Instagram detection via identities (`instagram`, `instagram_direct`, etc.)
- Merge rules:
  - Survivor determined by Instagram protection rules
  - Then normal email-owner-first logic
- Identity lifecycle:
  - Create → verify → make primary

## Webhook Contract

Expected JSON:

json
{
  "ticket_id": 12345,
  "requester_id": 67890,
  "comment": "… customer text with email foo@bar.com …"
}

Protected by **SHARED_KEY** as URL query parameter.

## Configuration

### Script Properties:
- ZENDESK_SUBDOMAIN
- ZENDESK_EMAIL
- ZENDESK_API_TOKEN
- SHARED_KEY

### Business Impact (Estimate)
- 20–30% reduction in “wrong user / wrong profile” incidents
- Cleaner reporting: tickets per customer now more accurate
- Fewer manual merges by CS leads

## My Role

Owned the design of merging rules, especially around Instagram safety, and implemented the full Apps Script webhook & retry logic.
