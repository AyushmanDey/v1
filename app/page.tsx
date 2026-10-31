import { Suspense } from "react";
import { CampusChat } from "@/components/campus/campus-chat";

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Loading your workspace…</main>}>
      <HomeContent searchParams={searchParams} />
    </Suspense>
  );
}

async function HomeContent({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { error_code: errorCode } = await searchParams;
  return <CampusChat confirmationExpired={errorCode === "otp_expired"} />;
}
