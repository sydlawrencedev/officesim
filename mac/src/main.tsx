import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OfficeSimCameraPage } from "../../src/ui/index";
import { installFetchBridge } from "./host/fetchBridge";
import "./styles.css";

installFetchBridge();

// The always-on-top mini camera window shows just the camera (see styles.css)
if (new URLSearchParams(window.location.search).has("mini")) document.documentElement.classList.add("op-mini");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OfficeSimCameraPage />
  </StrictMode>,
);
