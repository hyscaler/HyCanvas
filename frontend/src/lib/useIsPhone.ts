import { useMediaQuery } from "@/lib/useMediaQuery";

// A phone is a narrow portrait screen, or a touch screen too short for the
// desktop chrome (a phone turned sideways). The second clause needs a coarse
// pointer so a short desktop window keeps the desktop layout.
export const PHONE_QUERY = "(max-width: 639px), (max-height: 500px) and (pointer: coarse)";
const PHONE_PORTRAIT_QUERY = "(max-width: 639px) and (orientation: portrait)";

/**
 * Phone layout flags for the editor. `isPhone` switches the editor to its
 * canvas-first phone layout; `isPhonePortrait` picks the bottom tab bar and
 * bottom sheets, while a phone in landscape keeps a slim side rail and side
 * sheets because height is the scarce dimension there.
 */
export function useIsPhone(): { isPhone: boolean; isPhonePortrait: boolean } {
  const isPhone = useMediaQuery(PHONE_QUERY);
  const portrait = useMediaQuery(PHONE_PORTRAIT_QUERY);
  return { isPhone, isPhonePortrait: isPhone && portrait };
}
