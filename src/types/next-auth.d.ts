import type { DefaultSession } from "next-auth";
import type { GlobalRole } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      globalRole: GlobalRole;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    email: string;
    name: string;
    globalRole: GlobalRole;
  }
}
