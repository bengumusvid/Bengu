# PayPal payouts for Bengu

1. PayPal Developer (developer.paypal.com) → create an app with a Business account.
   Payouts must be enabled for that account (PayPal may need to approve it).
   Start in Sandbox.
2. Set the secrets (Supabase CLI):
   supabase secrets set PAYPAL_CLIENT_ID=... PAYPAL_SECRET=... PAYPAL_ENV=sandbox PAYPAL_MAX_USD=50
3. Deploy:
   supabase functions deploy paypal-payout
4. Test with a sandbox PayPal e-mail, then switch PAYPAL_ENV=live with the live keys.

Notes
- Only admins can call it (checked with bengu_admin_withdrawals).
- Assumes the admin list returns `account` (PayPal e-mail), `amount_usd`, `method`, `status`.
  If your column has another name, change `w.account` in index.ts.
- Each request is paid once (PayPal-Request-Id = bengu-wd-<id>).
- Payouts above PAYPAL_MAX_USD are refused and must be paid manually.
- PayPal charges a fee to the sender per payout. Keep enough balance in the PayPal account.
