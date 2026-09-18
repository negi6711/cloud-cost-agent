import { LoginForm } from "@/components/login-form";

/** Only same-site relative paths are accepted as a post-login destination. */
function safeNext(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/snapshots";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-semibold">Sign in to view your snapshot</h1>
      <p className="mt-4 leading-7 text-muted">
        Snapshots are private. Enter the work email you used on the form and we will send a one-time
        sign-in link.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          That sign-in link has expired or was already used. Request a new one below.
        </p>
      )}
      <div className="mt-8">
        <LoginForm callbackURL={safeNext(next)} />
      </div>
    </main>
  );
}
