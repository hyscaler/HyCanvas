import Head from "next/head";
import { AuthForm } from "@/components/auth/AuthForm";
import { tr } from "@/lib/i18n";
import { VIEWPORT } from "@/lib/viewport";

export default function SignupPage() {
  return (
    <>
      <Head>
        <meta key="viewport" name="viewport" content={VIEWPORT} />
        <title>{tr("page.create_account_hycanvas")}</title>
      </Head>
      <AuthForm mode="signup" />
    </>
  );
}
