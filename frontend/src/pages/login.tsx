import Head from "next/head";
import { AuthForm } from "@/components/auth/AuthForm";
import { tr } from "@/lib/i18n";

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>{tr("page.sign_in_hycanvas")}</title>
      </Head>
      <AuthForm mode="login" />
    </>
  );
}
