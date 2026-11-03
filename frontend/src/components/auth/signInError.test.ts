import { describe, it, expect } from "vitest";
import { tr } from "@/lib/i18n";
import { signInErrorMessage } from "./signInError";

describe("signInErrorMessage", () => {
  it("names a disabled account instead of blaming the captcha", () => {
    // The server answers 403 for both a failed captcha and a deactivated
    // account; only the code tells them apart.
    const disabled = signInErrorMessage(403, { code: "account_disabled" });
    expect(disabled).toBe(tr("errors.api_account_disabled"));
    expect(disabled).not.toBe(tr("auth.couldnt_verify_the_captcha_please_try_again"));
    expect(signInErrorMessage(403, { code: "captcha_failed" })).toBe(tr("auth.couldnt_verify_the_captcha_please_try_again"));
  });

  it("keeps the existing status mapping", () => {
    expect(signInErrorMessage(401, {})).toBe(tr("auth.invalid_email_or_password"));
    expect(signInErrorMessage(409, undefined)).toBe(tr("auth.an_account_with_this_email_already_exists"));
    expect(signInErrorMessage(500, { message: "x" })).toBeNull();
  });
});
