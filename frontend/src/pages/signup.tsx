import Head from "next/head";
import { AuthForm } from "@/components/auth/AuthForm";
import { tr } from "@/lib/i18n";

export default function SignupPage() {
  return (
    <>
      <Head>
        <title>{tr("page.create_account_hycanvas")}</title>
      </Head>
      <AuthForm mode="signup" />
    </>
  );
}
