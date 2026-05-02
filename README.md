# Email Resender

A Cloudflare Worker script that acts as an email proxy. It allows you to send emails from your custom domain by simply sending a message from your personal email client to a designated forwarding address using [Resend](https://resend.com)'s API.

### Environment variables:

You must provide the following environment variables (either in a `.dev.vars` file for local development or configured in your Cloudflare dashboard):

- `AUTHORIZED_SENDER`: The personal email address that the proxy will accept messages from (e.g., `you@gmail.com`). This prevents unauthorized users from sending emails through your domain.
- `RESEND_API_KEY`: Your API key from [Resend](https://resend.com), which is used to actually send the outgoing emails.
- `EMAIL_DOMAIN`: Your custom domain name (e.g., `yourdomain.com`).
- `MAGIC_PREFIX`: A special string (like `@` or `!`) used at the beginning of lines in your email body to specify routing commands without including them in the final email.

### Example

To send an email via your personal email client, draft a message to your Cloudflare Worker's routing address and use your `MAGIC_PREFIX` to specify the sender alias and recipient. 

If your `MAGIC_PREFIX` is set to `!`, your draft might look like this:

**To:** `worker@yourdomain.com` (Your Cloudflare routing address)<br>
**Subject:** `Hello from my custom domain!`<br>
**Body:**
```text
!from: contact@yourdomain.com
!to: customer@example.com
!cc: cc1@example.com, cc2@example.com
!bcc: bcc1@example.com, bcc2@example.com

Hi there!
This is the actual body of the email. Notice how the commands above will be stripped out so the recipient won't see them.
```



## Deploy

Install dependencies:

```bash
npm install
```

Deploy to cloudflare workers (login if prompted):

```bash
npx wrangler deploy
```
⚠️ **Note:** Wrangler may experience compatibility issues with Bun or other alternative package managers. I recommend using `npm` and `npx`.

---

<div align="center">
  Made with ❤️ & 🍣 by afsc19
</div>





