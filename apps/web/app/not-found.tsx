import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-3 text-muted">This page does not exist, or you do not have access to it.</p>
      <Link href="/" className="mt-6 inline-block font-semibold text-accent underline">
        Go to the home page
      </Link>
    </main>
  );
}
