import { tr } from "@/lib/i18n";
// The message for a failed sign-in or sign-up response, or null when the
// response carries no known meaning (the caller then shows the server's own
// message). The server answers 403 both for a failed captcha and for a
// deactivated account, so the problem code is checked before the status.

export function signInErrorMessage(status: number, body: unknown): string | null {
  if ((body as { code?: string } | undefined)?.code === "account_disabled") return tr("errors.api_account_disabled");
  if (status === 401) return tr("auth.invalid_email_or_password");
  if (status === 409) return tr("auth.an_account_with_this_email_already_exists");
  if (status === 403) return tr("auth.couldnt_verify_the_captcha_please_try_again");
  return null;
}
