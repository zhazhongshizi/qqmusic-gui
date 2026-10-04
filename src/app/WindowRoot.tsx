import { lazy, Suspense } from "react";

export type WindowRootLabel = "main" | "tray-menu";

const MainApp = lazy(async () => {
  const module = await import("./App");
  return { default: module.App };
});

const TrayMenu = lazy(async () => {
  const module = await import("../features/tray/TrayMenu");
  return { default: module.TrayMenu };
});

export function selectWindowRoot(label: string | undefined): WindowRootLabel | null {
  if (label === undefined || label === "main") return "main";
  if (label === "tray-menu") return "tray-menu";
  return null;
}

export function WindowRoot({ windowLabel }: { windowLabel?: string }) {
  const root = selectWindowRoot(windowLabel);

  if (root === null) return null;

  return (
    <Suspense fallback={null}>
      {root === "tray-menu" ? <TrayMenu /> : <MainApp />}
    </Suspense>
  );
}
