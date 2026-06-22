import Head from "next/head";
import { AuthForm } from "@/components/auth/AuthForm";

export default function SignupPage() {
  return (
    <>
      <Head>
        <title>Create account · HyCanvas</title>
      </Head>
      <AuthForm mode="signup" />
    </>
  );
}
