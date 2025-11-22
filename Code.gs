/* ===== Script Properties to define =====
ZENDESK_SUBDOMAIN  
ZENDESK_EMAIL     
ZENDESK_API_TOKEN  
SHARED_KEY         shared key for webhook 
*/

const SP = PropertiesService.getScriptProperties();

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply_("No body");
    }

    // Auth check
    const key = (e.parameter && e.parameter.key) || "";
    const sharedKey = SP.getProperty("SHARED_KEY");
    if (!sharedKey || key !== sharedKey) {
      return reply_("Invalid key");
    }

    const data = JSON.parse(e.postData.contents || "{}");
    const ticketId = data.ticket_id;
    const requesterId = String(data.requester_id);
    const commentText = (data.comment || "").trim();

    if (!ticketId || !requesterId || !commentText) {
      return reply_("Missing ticket/requester/comment");
    }

    // ===== Extract last email from transcript =====
    const emails = commentText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
    if (!emails || emails.length === 0) return reply_("No email found");
    const email = emails[emails.length - 1].toLowerCase();

    // ===== Zendesk Auth =====
    const subdomain = SP.getProperty("ZENDESK_SUBDOMAIN");
    const zdEmail = SP.getProperty("ZENDESK_EMAIL");
    const zdToken = SP.getProperty("ZENDESK_API_TOKEN");

    if (!subdomain || !zdEmail || !zdToken) {
      return reply_("Missing Zendesk config");
    }

    const authHeader = {
      Authorization:
        "Basic " + Utilities.base64Encode(`${zdEmail}/token:${zdToken}`),
    };

    // -------- Generic fetch with tiny 429 backoff ---------
    function fetchWithRetry(url, options, retries) {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      if (code === 429 && retries > 0) {
        // simple backoff: wait 1s and retry once
        Utilities.sleep(1000);
        return fetchWithRetry(url, options, retries - 1);
      }
      return res;
    }

    // -------- Helper Functions using backoff ---------

    function zdGET(url) {
      return fetchWithRetry(
        url,
        {
          method: "get",
          muteHttpExceptions: true,
          headers: authHeader,
        },
        1
      );
    }

    function zdPOST(url, payload) {
      return fetchWithRetry(
        url,
        {
          method: "post",
          contentType: "application/json",
          muteHttpExceptions: true,
          payload: JSON.stringify(payload || {}),
          headers: authHeader,
        },
        1
      );
    }

    function zdPUT(url, payload) {
      return fetchWithRetry(
        url,
        {
          method: "put",
          contentType: "application/json",
          muteHttpExceptions: true,
          payload: JSON.stringify(payload || {}),
          headers: authHeader,
        },
        1
      );
    }

    function zdPATCH(url, payload) {
      return fetchWithRetry(
        url,
        {
          method: "patch",
          contentType: "application/json",
          muteHttpExceptions: true,
          payload: JSON.stringify(payload || {}),
          headers: authHeader,
        },
        1
      );
    }

    // ===== 1. Search for existing user with this email =====
    const searchUrl =
      `https://${subdomain}.zendesk.com/api/v2/search.json?query=` +
      encodeURIComponent(`type:user email:${email}`);
    const searchRes = zdGET(searchUrl);
    const searchJson = JSON.parse(searchRes.getContentText() || "{}");
    const emailOwners = (searchJson.results || []).filter(
      (u) => u.email && u.email.toLowerCase() === email
    );

    // ===== 2. Load requester basic data (made for logging) =====
    const requesterUrl = `https://${subdomain}.zendesk.com/api/v2/users/${requesterId}.json`;
    const requesterRes = zdGET(requesterUrl);
    const requesterJson = JSON.parse(requesterRes.getContentText() || "{}");
    const requester = requesterJson.user;

    // ===== 3. Helper: check if user has Instagram identity =====
    function isInstagramUserById(userId) {
      const identitiesUrl = `https://${subdomain}.zendesk.com/api/v2/users/${userId}/identities.json`;
      const idRes = zdGET(identitiesUrl);
      const idJson = JSON.parse(idRes.getContentText() || "{}");
      const identities = idJson.identities || [];
      return identities.some((id) =>
        ["instagram", "ig", "instagram_direct"].includes(id.type)
      );
    }

    // ===== 4. CASE A: No existing user owns this email → add to requester =====
    if (emailOwners.length === 0) {
      return processEmailForUser(requesterId, email);
    }

    // There is at least one owner of this email
    let owner = emailOwners[0];
    const ownerId = String(owner.id);

    // If owner IS requester → just normalize email on requester
    if (ownerId === requesterId) {
      return processEmailForUser(requesterId, email);
    }

    // ===== 5. CASE B: Email belongs to another user =====

    // Instagram protection: if owner is Instagram user → merge requester INTO owner
    if (isInstagramUserById(ownerId)) {
      mergeUsers(ownerId, requesterId); // survivor = owner
      return processEmailForUser(ownerId, email);
    }

    // If requester is Instagram → requester must survive
    if (isInstagramUserById(requesterId)) {
      mergeUsers(requesterId, ownerId); // survivor = requester
      return processEmailForUser(requesterId, email);
    }

    // Default merge rule: email owner survives
    mergeUsers(ownerId, requesterId);
    return processEmailForUser(ownerId, email);

    // ===== Helper: Add/verify/make primary for given userId & email =====

    function processEmailForUser(userId, email) {
      const identitiesUrl = `https://${subdomain}.zendesk.com/api/v2/users/${userId}/identities.json`;
      const idRes = zdGET(identitiesUrl);
      const idJson = JSON.parse(idRes.getContentText() || "{}");
      const identities = idJson.identities || [];

      let existing = identities.find(
        (i) => i.type === "email" && i.value.toLowerCase() === email
      );

      // A) Add email identity if missing
      if (!existing) {
        const addRes = zdPOST(identitiesUrl, {
          identity: {
            type: "email",
            value: email,
          },
        });
        const addJson = JSON.parse(addRes.getContentText() || "{}");
        existing = addJson.identity;
      }

      if (!existing || !existing.id) {
        return reply_(
          `Error: could not create or find email identity for user ${userId}`
        );
      }

      const identityId = existing.id;

      // B) Verify email (low verification)
      zdPUT(
        `https://${subdomain}.zendesk.com/api/v2/users/${userId}/identities/${identityId}/verify.json`,
        {
          identity: {
            verified: true,
            verification_method: "low",
          },
        }
      );

      // C) Make primary
      zdPUT(
        `https://${subdomain}.zendesk.com/api/v2/users/${userId}/identities/${identityId}/make_primary.json`,
        {}
      );

      return reply_(
        `Success: Email ${email} is now primary & verified for user ${userId}`
      );
    }

    // ===== Helper: merge two users (source → survivor) =====

    function mergeUsers(survivorId, sourceId) {
      const mergeUrl = `https://${subdomain}.zendesk.com/api/v2/users/${survivorId}/merge.json`;
      const mergeRes = zdPOST(mergeUrl, {
        user: { id: Number(sourceId) },
      });

      const code = mergeRes.getResponseCode();
      if (code < 200 || code >= 300) {
        throw new Error(
          `Merge failed: ${code} → ${mergeRes.getContentText()}`
        );
      }
    }
  } catch (err) {
    return reply_("Error: " + err.message);
  }
}

function reply_(msg) {
  return ContentService.createTextOutput(msg);
}
