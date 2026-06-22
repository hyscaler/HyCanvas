import Head from "next/head";
import { AuthForm } from "@/components/auth/AuthForm";

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>Sign in · HyCanvas</title>
      </Head>
      <AuthForm mode="login" />
    </>
  );
}
