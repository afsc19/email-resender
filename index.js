import PostalMime from 'postal-mime';

export default {
  // send an email using resend.com's API
  async sendEmail(body, env) {
    const { replyTo, ...rest } = body;
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...rest,
        ...(replyTo ? {reply_to: replyTo} : {})
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
          text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\nBody:\n" + cleanBody,
          html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
        }, env));
      return;
    }

    const targetFrom = fromMatch[1].trim();

    console.log("Sending email from "+targetFrom+" to "+targetTo.join(', ')+". Authorized sender: "+message.from+". Target cc: "+(targetCc ? targetCc.join(', ') : "none")+". Target bcc: "+(targetBcc ? targetBcc.join(', ') : "none")+". Target reply-to: "+(targetReplyTo ? targetReplyTo.join(', ') : "none")+".");

    // send the email
    ctx.waitUntil(this.sendEmail({
        from: targetFrom,
        to: targetTo,
        cc: targetCc,
        bcc: targetBcc,
        replyTo: targetReplyTo,
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
        text: "Using the following target cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\nBody:\n" + cleanBody,
        html: "Using the following cc: "+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc: "+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<br>\ntarget reply-to: "+ (targetReplyTo ? targetReplyTo.join(', ') : "none") +"\n<br>\nBody:\n<br>\n" + cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));
  },
};
