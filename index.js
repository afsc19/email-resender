import PostalMime, { decodeWords, addressParser } from 'postal-mime';

export default {
  // send an email using resend.com's API
  async sendEmail(body, env) {
    const { from, to, cc, bcc, replyTo, inReplyTo, references, extraHeaders, attachments, ...rest } = body;

    // { name, address } (postal-mime's shape) to "Name" <address> (string)
    const toResendAddress = (e) => typeof e === "string"
      ? e
      : (e.name ? `"${e.name.replace(/(["\\])/g, '\\$1')}" <${e.address}>` : e.address);
    const toResendList = (value) => value
      ? (Array.isArray(value) ? value : [value]).map(toResendAddress)
      : undefined;

    // attachments arrive as raw bytes, resend wants base64.
    // encode in chunks: spreading a whole large file into String.fromCharCode overflows the call stack
    const toBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    };
    // inline images keep their content id so <img src="cid:..."> in the html still works
    const resendAttachments = (attachments || []).map(att => ({
      filename: att.filename || "attachment",
      content: toBase64(att.content),
      ...(att.mimeType ? { content_type: att.mimeType } : {}),
      ...(att.disposition === "inline" && att.contentId ? { content_id: att.contentId } : {}),
    }));

    // resend has no thread fields, send them as custom headers (message ids need the angle brackets back)
    const headers = Object.fromEntries(
      Object.entries({
        ...(extraHeaders || {}),
        "In-Reply-To": inReplyTo ? inReplyTo.map(id => `<${id}>`).join(' ') : undefined,
        "References": references ? references.map(id => `<${id}>`).join(' ') : undefined,
      }).filter(([, value]) => value)
    );

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...rest,
        from: toResendAddress(from),
        to: toResendList(to),
        cc: toResendList(cc),
        bcc: toResendList(bcc),
        ...(replyTo ? {reply_to: toResendList(replyTo)} : {}),
        ...(resendAttachments.length > 0 ? { attachments: resendAttachments } : {}),
        ...(Object.keys(headers).length > 0 ? { headers: headers } : {})
      }),
    });

    if (!resendResponse.ok) {
      const error = await resendResponse.text();
      console.error("Resend API error:", error);
    }
  },

  async email(message, env, ctx) {
    const EMAIL_DOMAIN = env.EMAIL_DOMAIN;
    const AUTHORIZED_SENDER = env.AUTHORIZED_SENDER;
    const MAGIC_PREFIX = env.MAGIC_PREFIX;
    // sender of the worker's own emails - unauthorized/missing-instructions notices & optional confirmation
    // NOTIFICATION_SENDER is the part before the @ (default "security"), or a full address like "emailsecurity@yourdomain.com"
    // a full address must be on our domain (same check as !from:), otherwise fall back to the default so notices still go out
    const notificationSender = (env.NOTIFICATION_SENDER || "security").trim();
    let NOTIFICATION_FROM = notificationSender.includes('@') ? notificationSender : `${notificationSender}@${EMAIL_DOMAIN}`;
    if (!NOTIFICATION_FROM.toLowerCase().endsWith('@' + EMAIL_DOMAIN.toLowerCase())) {
      console.error(`NOTIFICATION_SENDER "${notificationSender}" is not an address @${EMAIL_DOMAIN}, using security@${EMAIL_DOMAIN} instead.`);
      NOTIFICATION_FROM = `security@${EMAIL_DOMAIN}`;
    }
    // Hex-encode to guarantee no regex collision
    const escapedPrefix = Array.from(MAGIC_PREFIX)
        .map(c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');

    const parser = new PostalMime();
    const email = await parser.parse(message.raw);

    // postal-mime decodes encoded words
    const subject = email.subject || "";

    // email.text contains the "Clean" text without headers or MIME boundaries
    const fullText = email.text || "";



    // remove commandlines from body and html
    const textRegex = (cmd) => new RegExp(`^[ \\t]*${escapedPrefix}${cmd}:.*?(?:\\r?\\n|$)`, 'igm');
    const cleanBody = fullText
      .replace(textRegex('to'), "")
      .replace(textRegex('from'), "")
      .replace(textRegex('cc'), "")
      .replace(textRegex('bcc'), "")
      .replace(textRegex('reply-to'), "")

    let cleanHTML = undefined;
    if (email.html) {
      // a command line ends at <br>, a line break, </div>, or where the next <div>/<p> starts (not consumed)
      const htmlRegex = (cmd) => new RegExp(`(?:<div[^>]*>)?\\s*${escapedPrefix}${cmd}:.*?(?:<br\\s*\\/?>|\\r?\\n|<\\/div>|(?=<(?:div|p)[\\s>])|$)`, 'gi');
      cleanHTML = email.html
        .replace(htmlRegex('to'), '')
        .replace(htmlRegex('from'), '')
        .replace(htmlRegex('cc'), '')
        .replace(htmlRegex('bcc'), '')
        .replace(htmlRegex('reply-to'), '')
        
        // Clean up empty lines or divs that might be left over
        .replace(/(<div[^>]*>)(<br\s*\/?>)+/gi, '$1')
        .replace(/(<br\s*\/?>)+(<\/div>)/gi, '$2')
        .replace(/<div[^>]*>\s*<\/div>/gi, '');
    }
    
    console.log("subject: "+subject);
    console.log("dirty html: "+email.html);
    console.log("clean html: "+cleanHTML);

    // attachments in a provider neutral shape, sendEmail converts them to what its API needs
    const attachments = (email.attachments || []).map(att => ({
      filename: att.filename,
      mimeType: att.mimeType,
      disposition: att.disposition, // "attachment", "inline" or null
      contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : undefined, // without the angle brackets
      content: att.content, // ArrayBuffer (raw bytes)
    }));


    // match fields
    // only match commands at the start of a line, same as the ones stripped by textRegex
    const commandRegex = (cmd, value) => new RegExp(`^[ \\t]*${escapedPrefix}${cmd}:[ \\t]*(${value})`, 'im');
    const toMatch = fullText.match(commandRegex('to', '[^\\r\\n]+'));
    const fromMatch = fullText.match(commandRegex('from', '[^\\r\\n]+'));
    const ccMatch = fullText.match(commandRegex('cc', '[^\\r\\n]+'));
    const bccMatch = fullText.match(commandRegex('bcc', '[^\\r\\n]+'));
    const replyToMatch = fullText.match(commandRegex('reply-to', '[^\\r\\n]+'));

    // TO + CC + BCC + reply-to
    // comma separated, each "email", "Name <email>" or "\"Last, First\" <email>" -> { name, address }
    const parseList = (match) => {
      if (!match)
        return undefined;
      const list = addressParser(match[1], { flatten: true }).filter(a => a.address && a.address.includes('@'));
      return list.length > 0 ? list : undefined;
    };
    const targetTo = parseList(toMatch);
    const targetCc = parseList(ccMatch);
    const targetBcc = parseList(bccMatch);
    const targetReplyTo = parseList(replyToMatch);

    // check from
    const requestedFrom = parseList(fromMatch);
    const targetFrom = requestedFrom && requestedFrom[0].address.toLowerCase().endsWith('@' + EMAIL_DOMAIN.toLowerCase())
      ? requestedFrom[0]
      : undefined;

    // "Name <email>, email" for logs and notifications
    const formatAddresses = (addresses) => {
      const list = (Array.isArray(addresses) ? addresses : [addresses])
        .filter(a => a && a.address)
        .map(a => a.name ? `${a.name} <${a.address}>` : a.address);
      return list.length > 0 ? list.join(', ') : "none";
    };
    // beautify lol
    const escapeHtml = (value) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // keep the thread when replying
    const extractMessageIds = (value) => {
      const ids = (value || "").match(/<[^>]+>/g);
      return ids ? ids.map(id => id.slice(1, -1)) : undefined;
    };
    const targetInReplyTo = extractMessageIds(email.inReplyTo);
    // references should end with the parent id, fall back to in-reply-to if missing
    const targetReferences = extractMessageIds(email.references) || targetInReplyTo;

    // postal-mime leaves header values encoded (=?utf-8?B?...?=) and asText expects plain text
    const getHeader = (key) => {
      const header = email.headers.find(h => h.key === key);
      return header ? decodeWords(header.value) : undefined;
    };
    const targetThreadHeaders = {
      "Thread-Index": getHeader("thread-index"), // outlook threads
      "Thread-Topic": getHeader("thread-topic"), // outlook threads
    };

    // check email origin
    // envelope and header from can be forged, so also require DKIM + DMARC to pass for the authorized sender's domain.
    // cloudflare email routing records those results in an (ARC-)Authentication-Results header (authserv-id mx.cloudflare.net).
    // only the topmost one is trusted: servers prepend their headers, so fake ones added by the sender end up below cloudflare's.
    const AUTHSERV_ID = "mx.cloudflare.net";
    const authorizedAddress = AUTHORIZED_SENDER.toLowerCase();
    const authorizedDomain = authorizedAddress.split('@').pop();
    const authHeader = email.headers.find(h => h.key === "arc-authentication-results" || h.key === "authentication-results");

    // "i=1; mx.cloudflare.net; dkim=pass header.d=gmail.com ...; dmarc=pass header.from=gmail.com ..."
    const authParts = authHeader
      ? authHeader.value.replace(/\([^)]*\)/g, '').split(';').map(part => part.trim()).filter(part => part.length > 0)
      : [];
    if (authParts.length > 0 && /^i\s*=/i.test(authParts[0]))
      authParts.shift(); // ARC instance number
    const authservId = (authParts.shift() || "").toLowerCase();
    const authResults = authParts.map(part => {
      const [result, ...props] = part.split(/\s+/);
      const [method, value] = result.toLowerCase().split('=');
      return {
        method: method,
        value: value,
        props: Object.fromEntries(props.map(p => p.split('=')).map(([k, v]) => [k.toLowerCase(), (v || "").toLowerCase()])),
      };
    });
    const dkimPass = authResults.some(r => r.method === "dkim" && r.value === "pass" && r.props["header.d"] === authorizedDomain);
    const dmarcPass = authResults.some(r => r.method === "dmarc" && r.value === "pass" && r.props["header.from"] === authorizedDomain);

    const authFailures = [];
    if ((message.from || "").toLowerCase() !== authorizedAddress)
      authFailures.push("envelope from");
    if (!email.from || (email.from.address || "").toLowerCase() !== authorizedAddress)
      authFailures.push("header from");
    if (authservId !== AUTHSERV_ID)
      authFailures.push(`authentication results not from ${AUTHSERV_ID} (got "${authservId || "none"}")`);
    if (!dkimPass)
      authFailures.push(`dkim pass for ${authorizedDomain}`);
    if (!dmarcPass)
      authFailures.push(`dmarc pass for ${authorizedDomain}`);

    console.log("Sender authentication: "+(authFailures.length === 0 ? "ok" : "failed ("+authFailures.join(', ')+")")+". Results: "+(authHeader ? authHeader.value : "none"));

    if (authFailures.length > 0) {
      console.error("Unauthorized sender: "+message.from);

      const fields = [
        ["Failed checks", authFailures.join(', ')],
        ["Authentication results", authHeader ? authHeader.value : "none"],
        ["Envelope from", message.from],
        ["Envelope to", message.to],
        ["Header from", formatAddresses(email.from)],
        ["Header to", formatAddresses(email.to)],
        ["Header cc", formatAddresses(email.cc)],
        ["Header reply-to", formatAddresses(email.replyTo)],
        ["Header date", email.date || "none"],
        ["Header message-id", email.messageId || "none"],
        ["Header in-reply-to", email.inReplyTo || "none"],
        ["Header references", email.references || "none"],
        ["Requested from", fromMatch ? fromMatch[1].trim() : "none"],
        ["Requested to", targetTo ? formatAddresses(targetTo) : "none"],
        ["Requested cc", targetCc ? formatAddresses(targetCc) : "none"],
        ["Requested bcc", targetBcc ? formatAddresses(targetBcc) : "none"],
        ["Requested reply-to", targetReplyTo ? formatAddresses(targetReplyTo) : "none"],
        ["Attachments", attachments.length > 0 ? attachments.map(att => att.filename).join(', ') : "none"],
      ];
      const fieldsText = fields.map(([label, value]) => label+": "+value).join("\n");
      const fieldsHTML = fields.map(([label, value]) => label+": "+escapeHtml(String(value))).join("\n<br>\n");

      ctx.waitUntil(this.sendEmail({
        from: NOTIFICATION_FROM,
        to: AUTHORIZED_SENDER,
        subject: "Unauthorized message from "+message.from+" to "+message.to+": " + subject,
          text: fieldsText + "\nBody:\n" + cleanBody,
          html: fieldsHTML + "\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

      message.setReject("Unauthorized sender.");
      return;
    }

    // no TO or FROM found
    if (!targetTo || !targetFrom) {
      console.error(`${MAGIC_PREFIX} commands not found in clean text.`);
      ctx.waitUntil(this.sendEmail({
          from: NOTIFICATION_FROM,
          to: AUTHORIZED_SENDER,
          subject: `Missing ${MAGIC_PREFIX} instructions in body from `+message.from+" to "+message.to+": " + subject,
          text: "Requested from: "+ (fromMatch ? fromMatch[1].trim() : "none") +" (must be an address @"+ EMAIL_DOMAIN +")\nUsing the following target cc: "+ formatAddresses(targetCc) +"\ntarget bcc: "+ formatAddresses(targetBcc) +"\ntarget reply-to: "+ formatAddresses(targetReplyTo) +"\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\nBody:\n" + cleanBody,
          html: "Requested from: "+ escapeHtml(fromMatch ? fromMatch[1].trim() : "none") +" (must be an address @"+ escapeHtml(EMAIL_DOMAIN) +")\n<br>\nUsing the following cc: "+ escapeHtml(formatAddresses(targetCc)) +"\n<br>\ntarget bcc: "+ escapeHtml(formatAddresses(targetBcc)) +"\n<br>\ntarget reply-to: "+ escapeHtml(formatAddresses(targetReplyTo)) +"\n<br>\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\n<br>\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
        }, env));
      return;
    }

    // bcc myself a copy of the exact email that was sent (replies work yay)
    // skipped if you're already one of the recipients
    const authorizedIsRecipient = [...targetTo, ...(targetCc || []), ...(targetBcc || [])]
      .some(a => a.address.toLowerCase() === authorizedAddress);
    const outgoingBcc = authorizedIsRecipient
      ? targetBcc
      : [...(targetBcc || []), { name: "", address: AUTHORIZED_SENDER }];

    console.log("Sending email from "+formatAddresses(targetFrom)+" to "+formatAddresses(targetTo)+". Authorized sender: "+message.from+". Target cc: "+formatAddresses(targetCc)+". Target bcc: "+formatAddresses(targetBcc)+". Target reply-to: "+formatAddresses(targetReplyTo)+". In reply to: "+(targetInReplyTo ? targetInReplyTo.join(', ') : "none")+". References: "+(targetReferences ? targetReferences.join(', ') : "none")+". Copy for "+AUTHORIZED_SENDER+": "+(authorizedIsRecipient ? "already a recipient" : "bcc")+".");

    // send the email
    ctx.waitUntil(this.sendEmail({
        from: targetFrom,
        to: targetTo,
        cc: targetCc,
        bcc: outgoingBcc,
        replyTo: targetReplyTo,
        inReplyTo: targetInReplyTo,
        references: targetReferences,
        extraHeaders: targetThreadHeaders,
        subject: subject,
        text: cleanBody,
        html: cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

    // optional summary email to the authorized sender according to SEND_CONFIRMATION
    // attachments are only listed by name: the bcc copy already has the files, so no duplicates :D
    if (["true", "1", "yes"].includes(String(env.SEND_CONFIRMATION || "").toLowerCase())) {
      const attachmentNames = attachments.length > 0 ? attachments.map(att => att.filename || "unnamed").join(', ') : "none";
      ctx.waitUntil(this.sendEmail({
          from: NOTIFICATION_FROM,
          to: AUTHORIZED_SENDER,
          subject: "Email sent From "+formatAddresses(targetFrom)+" to "+formatAddresses(targetTo)+": "+ subject,
          text: "Using the following target cc: "+ formatAddresses(targetCc) +"\ntarget bcc: "+ formatAddresses(targetBcc) +"\ntarget reply-to: "+ formatAddresses(targetReplyTo) +"\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\nattachments: "+ attachmentNames +"\nBody:\n" + cleanBody,
          html: "Using the following cc: "+ escapeHtml(formatAddresses(targetCc)) +"\n<br>\ntarget bcc: "+ escapeHtml(formatAddresses(targetBcc)) +"\n<br>\ntarget reply-to: "+ escapeHtml(formatAddresses(targetReplyTo)) +"\n<br>\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\n<br>\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\n<br>\nattachments: "+ escapeHtml(attachmentNames) +"\n<br>\nBody:\n<br>\n" + cleanHTML,
        }, env));
    }
  },
};
