import PostalMime from 'postal-mime';

export default {
  async sendEmail(body, env) {
    const { from, to, cc, bcc, subject, text, html } = body;
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
    const toArray = Array.isArray(to)
      ? to.map(e => ({ email: e }))
      : [{ email: to }];
    const ccArray = cc
      ? ( Array.isArray(cc)
          ? cc.map(e => ({ email: e }))
          : [{ email: cc }] )
      : undefined;
    const bccArray = bcc
      ? ( Array.isArray(bcc)
          ? bcc.map(e => ({ email: e }))
          : [{ email: bcc }] )
      : undefined;

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

    const subject = message.headers.get("subject") || "";


    const parser = new PostalMime();
    const email = await parser.parse(message.raw);

    // email.text contains the "Clean" text without headers or MIME boundaries
    const fullText = email.text || "";



    // remove commandlines from body and html
    const textRegex = (cmd) => new RegExp(`^[ \\t]*${escapedPrefix}${cmd}:.*?(?:\\r?\\n|$)`, 'igm');
    const cleanBody = fullText
      .replace(textRegex('to'), "")
      .replace(textRegex('from'), "")
      .replace(textRegex('cc'), "")
      .replace(textRegex('bcc'), "");

    let cleanHTML = undefined;
    if (email.html) {
      const htmlRegex = (cmd) => new RegExp(`(?:<div[^>]*>)?\\s*${escapedPrefix}${cmd}:.*?(?:<br\\s*\\/?>|\\r?\\n|<\\/div>|$)`, 'gi');
      cleanHTML = email.html
        .replace(htmlRegex('to'), '')
        .replace(htmlRegex('from'), '')
        .replace(htmlRegex('cc'), '')
        .replace(htmlRegex('bcc'), '')
        
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


    // check email origin
    if (message.from !== AUTHORIZED_SENDER) {
      console.error("Unauthorized sender: "+message.from);
      ctx.waitUntil(this.sendEmail({
        from: `security@${EMAIL_DOMAIN}`,
        to: AUTHORIZED_SENDER,
        subject: "Unauthorized message from "+message.from+" to "+message.to+": " + subject,
          text: "Using the following cc: "+cc+"\nBody:\n" + cleanBody,
          html: "Using the following cc: "+cc+"\n<br>\nBody:\n<br>\n" + cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

      message.setReject("Unauthorized sender.");
      return;
    }

    // match fields
    const toMatch = fullText.match(new RegExp(`${escapedPrefix}to:\\s*([^\\s\\r\\n]+@[^\\s\\r\\n]+)`, 'i'));
    const fromMatch = fullText.match(new RegExp(`${escapedPrefix}from:\\s*([^\\s\\r\\n]+@${EMAIL_DOMAIN.replace(/\\./g, '\\\\.')})`, 'i'));
    const ccMatch = fullText.match(new RegExp(`${escapedPrefix}cc:\\s*([^\\r\\n]+)`, 'i'));
    const bccMatch = fullText.match(new RegExp(`${escapedPrefix}bcc:\\s*([^\\r\\n]+)`, 'i'));

    // CC + BCC
    let targetCc = undefined;
    let targetBcc = undefined;
    if (ccMatch) {
      targetCc = ccMatch[1].split(',').map(email => email.trim()).filter(email => email.length > 0);
      if (targetCc.length === 0)
        targetCc = undefined;
    }
    if (bccMatch) {
      targetBcc = bccMatch[1].split(',').map(email => email.trim()).filter(email => email.length > 0);
      if (targetBcc.length === 0)
        targetBcc = undefined;
    }

    // no TO or FROM found
    if (!toMatch || !fromMatch) {
      console.error(`${MAGIC_PREFIX} commands not found in clean text.`);
      ctx.waitUntil(this.sendEmail({
          from: `security@${EMAIL_DOMAIN}`,
          to: AUTHORIZED_SENDER,
          subject: `Missing ${MAGIC_PREFIX} instructions in body from `+message.from+" to "+message.to+": " + subject,
          text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\nBody:\n" + cleanBody,
          html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
        }, env));
      return;
    }

    const targetTo = toMatch[1].trim();
    const targetFrom = fromMatch[1].trim();

    console.log("Sending email from "+targetFrom+" to "+targetTo+". Authorized sender: "+message.from+". Target cc: "+(targetCc ? targetCc.join(', ') : "none")+". Target bcc: "+(targetBcc ? targetBcc.join(', ') : "none")+".");

    // send the email
    ctx.waitUntil(this.sendEmail({
        from: targetFrom,
        to: targetTo,
        cc: targetCc,
        bcc: targetBcc,
        subject: subject,
        text: cleanBody,
        html: cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

    // send a confirmation email to the authorized_sender
    ctx.waitUntil(this.sendEmail({
        from: `security@${EMAIL_DOMAIN}`,
        to: AUTHORIZED_SENDER,
        subject: "Email sent From "+targetFrom+" to "+targetTo+": "+ subject,
        text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\nBody:\n" + cleanBody,
        html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));
  },
};
