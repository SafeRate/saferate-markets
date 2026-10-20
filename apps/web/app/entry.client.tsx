import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import {
	reportRecoverableError,
	startClientErrorReporting,
} from "@/lib/clientErrors.client";

/*
 * React Router's default client entry, plus error reporting installed BEFORE
 * hydrateRoot. Installed from root's useEffect it would attach after hydration
 * committed, and every hydration mismatch would go unrecorded — which is what
 * saferate-ai's consumer app found when Clarity counted errors its sink had not.
 */
startClientErrorReporting();

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<HydratedRouter />
		</StrictMode>,
		{ onRecoverableError: reportRecoverableError },
	);
});
