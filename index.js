import PostalMime from 'postal-mime';

export default {
  // send an email using resend.com's API
  async sendEmail(body, env) {
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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

    const subject = message.headers.get("subject") || "";


    const parser = new PostalMime();
    const email = await parser.parse(message.raw);

    // email.text contains the "Clean" text without headers or MIME boundaries
    const fullText = email.text || "";



    // remove commandlines from body and html
    const cleanBody = fullText
      .replace(new RegExp(`^[ \\t]*${MAGIC_PREFIX}to:.*(?:\\r?\\n|$)`, 'im'), "")
      .replace(new RegExp(`^[ \\t]*${MAGIC_PREFIX}from:.*(?:\\r?\\n|$)`, 'im'), "")
      .replace(new RegExp(`^[ \\t]*${MAGIC_PREFIX}cc:.*(?:\\r?\\n|$)`, 'im'), "")
      .replace(new RegExp(`^[ \\t]*${MAGIC_PREFIX}bcc:.*(?:\\r?\\n|$)`, 'im'), "");

    let cleanHTML = undefined;
    if (email.html) {
      cleanHTML = email.html
        // Remove to + any link following it + any break tag
        .replace(new RegExp(`${MAGIC_PREFIX}to:\\s*(<a[^>]*>.*?<\\/a>|[^<]+)?(<br\\s*\\/?>)?`, 'gi'), '')

        // Remove from + any link following it + any break tag
        .replace(new RegExp(`${MAGIC_PREFIX}from:\\s*(<a[^>]*>.*?<\\/a>|[^<]+)?(<br\\s*\\/?>)?`, 'gi'), '')

        // Remove cc + any link following it + any break tag
        .replace(new RegExp(`${MAGIC_PREFIX}cc:\\s*(<a[^>]*>.*?<\\/a>|[^<]+)?(<br\\s*\\/?>)?`, 'gi'), '')

        // Remove bcc + any link following it + any break tag
        .replace(new RegExp(`${MAGIC_PREFIX}bcc:\\s*(<a[^>]*>.*?<\\/a>|[^<]+)?(<br\\s*\\/?>)?`, 'gi'), '')
        
        // Clean up leading <br> tags that might be left at the start of the div
        .replace(/(<div[^>]*>)(<br\s*\/?>)+/gi, '$1')
        
        // Clean up trailing <br> tags before the closing div
        .replace(/(<br\s*\/?>)+(<\/div>)/gi, '$2');
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
          text: "Using the following cc:"+cc+"\nBody:\n" + cleanBody,
          html: "Using the following cc:"+cc+"\n<br>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
      }, env));

      message.setReject("Unauthorized sender.");
      return;
    }

    // match fields
    const toMatch = fullText.match(new RegExp(`${MAGIC_PREFIX}to:\\s*([^\\s\\r\\n]+@[^\\s\\r\\n]+)`, 'i'));
    const fromMatch = fullText.match(new RegExp(`${MAGIC_PREFIX}from:\\s*([^\\s\\r\\n]+@${EMAIL_DOMAIN.replace(/\\./g, '\\\\.')})`, 'i'));
    const ccMatch = fullText.match(new RegExp(`${MAGIC_PREFIX}cc:\\s*([^\\r\\n]+)`, 'i'));
    const bccMatch = fullText.match(new RegExp(`${MAGIC_PREFIX}bcc:\\s*([^\\r\\n]+)`, 'i'));

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
          text: "Using the following target cc:"+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc:"+ (targetBcc ? targetBcc.join(', ') : "none") +"\nBody:\n" + cleanBody,
          html: "Using the following cc:"+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc:"+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<bt>\nBody:\n<br>\n" + cleanHTML,
          attachments: attachments.length > 0 ? attachments : undefined,
        }, env));
      return;
    }

    const targetTo = toMatch[1].trim();
    const targetFrom = fromMatch[1].trim();
    

    console.log("Sending email from "+targetFrom+" to "+targetTo+". Authorized sender: "+message.from+". Target cc:"+(targetCc ? targetCc.join(', ') : "none")+". Target bcc:"+(targetBcc ? targetBcc.join(', ') : "none")+".")

    // send the email
    ctx.waitUntil(this.sendEmail({
        from: targetFrom,
        to: targetTo,
        cc: targetCc,
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
        text: "Using the following target cc:"+ (targetCc ? targetCc.join(', ') : "none") +"\ntarget bcc:"+ (targetBcc ? targetBcc.join(', ') : "none") +"\nBody:\n" + cleanBody,
        html: "Using the following cc:"+ (targetCc ? targetCc.join(', ') : "none") +"\n<br>\ntarget bcc:"+ (targetBcc ? targetBcc.join(', ') : "none") +"\n<bt>\nBody:\n<br>\n" + cleanHTML,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, env));
  },
};
