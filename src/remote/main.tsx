import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/app.css";
import "./remote.css";
import { RemoteApp } from "./RemoteApp";
createRoot(document.getElementById("root")!).render(<RemoteApp />);

