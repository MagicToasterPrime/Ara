import type { DefaultSession } from "next-auth";
import type { GlobalRole } from "@prisma/client";
import type { ClassLevel } from "@/lib/class-levels";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      globalRole: GlobalRole;
      classLevel?: ClassLevel | string;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    email: string;
    name: string;
    globalRole: GlobalRole;
    classLevel?: ClassLevel | string;
  }
}
