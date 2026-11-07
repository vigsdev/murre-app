import { Button, TextInput, mergeThemeOverrides, rem } from "@mantine/core";
import { shadcnTheme } from "./theme";

/**
 * The shadcn theme, tightened for a narrow panel inside After Effects: smaller type, smaller controls. "Geist" is not bundled, so the
 * font falls back to the system one rather than the browser's default serif. Shared by the panel and the "Add to Murre" popup.
 */
export const panelTheme = mergeThemeOverrides(shadcnTheme, {
  fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  fontSizes: { xs: rem(11), sm: rem(12), md: rem(13), lg: rem(15), xl: rem(17) },
  lineHeights: { xs: rem(15), sm: rem(17), md: rem(19), lg: rem(22) },
  components: {
    Button: Button.extend({ defaultProps: { size: "xs", variant: "filled" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "xs" } }),
  },
});
