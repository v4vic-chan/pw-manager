import { useEffect } from "react";
import { AuthFlow } from "./auth/AuthFlow";
import type { AuthController } from "./auth/authController";

export function App({ controller }: { controller: AuthController }) {
  useEffect(() => {
    void controller.boot();
  }, [controller]);

  return <AuthFlow controller={controller} />;
}
