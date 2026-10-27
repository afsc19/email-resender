import PostalMime, { decodeWords } from 'postal-mime';

export default {
  async sendEmail(body, env) {
    const { from, to, cc, bcc, replyTo, inReplyTo, references, extraHeaders, subject, text, html } = body;
    const authHeader = "Basic " + btoa(`${env.STALWART_USER}:${env.STALWART_PASS}`);

    // fetch accountId
    const sessionRes = await fetch(`https://${env.STALWART_ENDPOINT}/.well-known/jmap`, {
      headers: { "Authorization": authHeader }
    });
    const session = await sessionRes.json();
    const accountId = session.primaryAccounts["urn:ietf:params:jmap:submission"];

    // fetch mailboxes and identitities
    const detailsRes = await fetch(`https://${env.STALWART_ENDPOINT}/jmap/`, {
      method: "POST",
      headers: { "Authorization": authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
        methodCalls: [
          ["Mailbox/get", { accountId: accountId }, "0"],
          ["Identity/get", { accountId: accountId }, "1"]
        ]
      })
    });
    const detailsData = await detailsRes.json();

    // mailbox id
    const mailboxes = detailsData.methodResponses[0][1].list;
    const targetFolder = mailboxes.find(m => m.role === "drafts" || m.role === "outbox") || mailboxes[0]; // basically use drafts
    const targetMailboxId = targetFolder.id;

    // identity id
    const identities = detailsData.methodResponses[1][1].list;
    const identityId = identities[0].id; // Primary identity ID


    // convert recipients to arrays
    const toAddressList = (value) => value
      ? (Array.isArray(value) ? value : [value]).map(e => ({ email: e }))
      : undefined;
    const toArray = toAddressList(to);
    const ccArray = toAddressList(cc);
    const bccArray = toAddressList(bcc);
    const replyToArray = toAddressList(replyTo);

    // custom headers, e.g. { "Thread-Index": "..." } -> { "header:Thread-Index:asText": "..." }
    const extraHeaderProps = Object.fromEntries(
      Object.entries(extraHeaders || {})
        .filter(([, value]) => value)
        .map(([name, value]) => [`header:${name}:asText`, value])
    );

    const jmapPayload = {
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission"
      ],
      methodCalls: [
        [
          "Email/set",
          {
            accountId: accountId,
            create: {
              msg1: {
                mailboxIds: { [targetMailboxId]: true },
                from: [{ email: from }],
                to: toArray,
                ...(ccArray ? { cc: ccArray } : {}),
                ...(bccArray ? { bcc: bccArray } : {}),
                ...(replyToArray ? { replyTo: replyToArray } : {}),

                // thread headers
                ...(inReplyTo ? { inReplyTo: inReplyTo } : {}),
                ...(references ? { references: references } : {}),
                ...extraHeaderProps,

                subject: subject,
                bodyValues: {
                  b1: { value: text || "" },
                  ...(html ? { b2: { value: html } } : {})
                },
                textBody: [{ partId: "b1", type: "text/plain" }],
                ...(html ? { htmlBody: [{ partId: "b2", type: "text/html" }] } : {})
              }
            }
          },
          "0"
        ],
        [
          "EmailSubmission/set",
          {
            accountId: accountId,
            create: {
              sub1: {
                emailId: "#msg1",
                identityId: identityId
              }
            }
          },
          "1"
        ]
      ]
    };

    const response = await fetch(`https://${env.STALWART_ENDPOINT}/jmap/`, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jmapPayload),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Server error:", error);
    }
  },

  async email(message, env, ctx) {
    const EMAIL_DOMAIN = env.EMAIL_DOMAIN;
    const AUTHORIZED_SENDER = env.AUTHORIZED_SENDER;
    const MAGIC_PREFIX = env.MAGIC_PREFIX;
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
      const htmlRegex = (cmd) => new RegExp(`(?:<div[^>]*>)?\\s*${escapedPrefix}${cmd}:.*?(?:<br\\s*\\/?>|\\r?\\n|<\\/div>|$)`, 'gi');
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

    // map attachments (if any) to resend.com's format
    const attachments = (email.attachments || []).map(att => ({
      filename: att.filename,
      content: btoa(String.fromCharCode(...new Uint8Array(att.content))), // Convert to Base64
    }));


    // match fields
    // only match commands at the start of a line, same as the ones stripped by textRegex
    const commandRegex = (cmd, value) => new RegExp(`^[ \\t]*${escapedPrefix}${cmd}:[ \\t]*(${value})`, 'im');
    const toMatch = fullText.match(commandRegex('to', '[^\\r\\n]+'));
    const fromMatch = fullText.match(commandRegex('from', `[^\\s\\r\\n]+@${EMAIL_DOMAIN.replace(/\\./g, '\\\\.')}`));
    const ccMatch = fullText.match(commandRegex('cc', '[^\\r\\n]+'));
    const bccMatch = fullText.match(commandRegex('bcc', '[^\\r\\n]+'));
    const replyToMatch = fullText.match(commandRegex('reply-to', '[^\\r\\n]+'));

    // TO + CC + BCC + reply-to
    const parseList = (match) => {
      if (!match)
        return undefined;
      const list = match[1].split(',').map(email => email.trim()).filter(email => email.includes('@'));
      return list.length > 0 ? list : undefined;
    };
    const targetTo = parseList(toMatch);
    const targetCc = parseList(ccMatch);
    const targetBcc = parseList(bccMatch);
    const targetReplyTo = parseList(replyToMatch);

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
    if (message.from !== AUTHORIZED_SENDER) {
      console.error("Unauthorized sender: "+message.from);

      // headers of the incoming message (postal-mime address objects)
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
      const rawFromMatch = fullText.match(commandRegex('from', '[^\\r\\n]+'));

      const fields = [
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
        ["Requested from", rawFromMatch ? rawFromMatch[1].trim() : "none"],
        ["Requested to", targetTo ? targetTo.join(', ') : "none"],
        ["Requested cc", targetCc ? targetCc.join(', ') : "none"],
        ["Requested bcc", targetBcc ? targetBcc.join(', ') : "none"],
        ["Requested reply-to", targetReplyTo ? targetReplyTo.join(', ') : "none"],
        ["Attachments", attachments.length > 0 ? attachments.map(att => att.filename).join(', ') : "none"],
      ];
      const fieldsText = fields.map(([label, value]) => label+": "+value).join("\n");
      const fieldsHTML = fields.map(([label, value]) => label+": "+escapeHtml(String(value))).join("\n<br>\n");

      ctx.waitUntil(this.sendEmail({
        from: `security@${EMAIL_DOMAIN}`,
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
    if (!targetTo || !fromMatch) {
      console.error(`${MAGIC_PREFIX} commands not found in clean text.`);
      ctx.waitUntil(this.sendEmail({
          from: `security@${EMAIL_DOMAIN}`,
          to: AUTHORIZED_SENDER,
          subject: `Missing ${MAGIC_PREFIX} instructions in body from `+message.from+" to "+message.to+": " + subject,
          text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\nBody:\n" + cleanBody,
          html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\n<br>\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\n<br>\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
        }, env));
      return;
    }

    const targetFrom = fromMatch[1].trim();

    console.log("Sending email from "+targetFrom+" to "+targetTo.join(', ')+". Authorized sender: "+message.from+". Target cc: "+(targetCc ? targetCc.join(', ') : "none")+". Target bcc: "+(targetBcc ? targetBcc.join(', ') : "none")+". Target reply-to: "+(targetReplyTo ? targetReplyTo.join(', ') : "none")+". In reply to: "+(targetInReplyTo ? targetInReplyTo.join(', ') : "none")+". References: "+(targetReferences ? targetReferences.join(', ') : "none")+".");

    // send the email
    ctx.waitUntil(this.sendEmail({
        from: targetFrom,
        to: targetTo,
        cc: targetCc,
        bcc: targetBcc,
        replyTo: targetReplyTo,
        inReplyTo: targetInReplyTo,
        references: targetReferences,
        extraHeaders: targetThreadHeaders,
        subject: subject,
        text: cleanBody,
        html: cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

    // send a confirmation email to the authorized_sender
    ctx.waitUntil(this.sendEmail({
        from: `security@${EMAIL_DOMAIN}`,
        to: AUTHORIZED_SENDER,
        subject: "Email sent From "+targetFrom+" to "+targetTo.join(', ')+": "+ subject,
        text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\nBody:\n" + cleanBody,
        html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\n<br>\nin-reply-to: "+ (targetInReplyTo ? targetInReplyTo.join(', ') : "none") +"\n<br>\nreferences: "+ (targetReferences ? targetReferences.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));
  },
};
