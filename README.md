# Email Resender

A Cloudflare Worker script that acts as an email proxy. It allows you to send emails from your custom domain by simply sending a message from your personal email client to a designated forwarding address using:
- [Resend](https://resend.com)'s API ([main branch](https://github.com/afsc19/email-resender/tree/main))
- [Stalwart](https://stalw.art/)'s API ([stalwart branch](https://github.com/afsc19/email-resender/tree/stalwart))

### Environment variables:

You must provide the following environment variables (either in a `.dev.vars` file for local development or configured in your Cloudflare dashboard):

- `AUTHORIZED_SENDER`: The personal email address that the proxy will accept messages from (e.g., `you@gmail.com`). This prevents unauthorized users from sending emails through your domain.
- `EMAIL_DOMAIN`: Your custom domain name (e.g., `yourdomain.com`).
- `MAGIC_PREFIX`: A special string (like `@` or `!`) used at the beginning of lines in your email body to specify routing commands without including them in the final email.

Optional (used with their default value when not set):
- `NOTIFICATION_SENDER`: The address the worker's own emails come from: the unauthorized-sender and missing-instructions notices, and the optional confirmation. Either just the part before the `@` (e.g. `alerts` → `alerts@yourdomain.com`) or a full address on your domain. A full address on another domain is ignored: the worker logs an error and uses the default instead, so notices still go out.
  **Default:** `security` (i.e. `security@yourdomain.com`).
- `SEND_CONFIRMATION`: Set to `true` (or `1`/`yes`) to also receive a summary email (from the `NOTIFICATION_SENDER` address) after each send, listing the recipients, cc, bcc, reply-to, thread headers and attachment names. You always get a bcc copy of the exact email that was sent, so this is only useful if you want the extra details. Attachments are listed by name, not attached again.
  **Default:** `false` (no summary email).

Main (Resend) branch:
- `RESEND_API_KEY`: Your API key from [Resend](https://resend.com), which is used to actually send the outgoing emails.

Stalwart branch:
- `STALWART_ENDPOINT`: The endpoint of your Stalwart instance.
- `STALWART_USER`: The username associated to the account you want to use in your Stalwart instance.
- `STALWART_PASS`: The password of the account you want to use in your Stalwart instance.

### Example

To send an email via your personal email client, draft a message to your Cloudflare Worker's routing address and use your `MAGIC_PREFIX` to specify the sender alias and recipient. 

If your `MAGIC_PREFIX` is set to `!`, your draft might look like this:

**To:** `worker@yourdomain.com` (Your Cloudflare routing address)<br>
**Subject:** `Hello from my custom domain!`<br>
**Body:**
```text
!from: Acme Support <contact@yourdomain.com>
!to: Jane Customer <customer@example.com>, partner@example.com
!reply-to: Support Team <support@yourdomain.com>, sales@yourdomain.com
!cc: "Doe, John" <cc1@example.com>, cc2@example.com
!bcc: bcc1@example.com, bcc2@example.com

Hi there!
This is the actual body of the email. Notice how the commands above will be stripped out so the recipient won't see them.
```

Every address can be written as:
- `email@example.com`
- `Name <email@example.com>`, to show a display name
- `"Last, First" <email@example.com>`, with quotes when the name contains a comma

`to`, `cc`, `bcc` and `reply-to` take a comma-separated list. `from` takes a single address, which must be on your `EMAIL_DOMAIN`.



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





