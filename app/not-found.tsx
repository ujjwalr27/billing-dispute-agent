import Link from "next/link";
import { Folder } from "./icons";
import { Empty } from "./ui";

export default function NotFound() {
  return (
    <main className="container">
      <div className="list" style={{ maxWidth: 520, margin: "48px auto 0" }}>
        <Empty icon={<Folder size={22} />} title="Case not found">
          It may have been removed, or the link is wrong. <Link href="/">Back to all cases</Link>
        </Empty>
      </div>
    </main>
  );
}
