// src/components/ui/font-weight-extension.ts
// Custom font weight extension for TipTap editor with Space Grotesk weights
// v1

import { Extension } from "@tiptap/core";
import "@tiptap/extension-text-style";

export type FontWeightOptions = {
    types: string[];
};

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        fontWeight: {
            /**
             * Set the font weight
             */
            setFontWeight: (fontWeight: string) => ReturnType;
            /**
             * Unset the font weight
             */
            unsetFontWeight: () => ReturnType;
        };
    }
}

export const FontWeight = Extension.create<FontWeightOptions>({
    name: "fontWeight",

    addOptions() {
        return {
            types: ["textStyle"],
        };
    },

    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    fontWeight: {
                        default: null,
                        parseHTML: (element) =>
                            element.style.fontWeight || null,
                        renderHTML: (attributes) => {
                            if (!attributes.fontWeight) {
                                return {};
                            }

                            return {
                                style: `font-weight: ${attributes.fontWeight}`,
                            };
                        },
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            setFontWeight:
                (fontWeight: string) =>
                ({ chain }) => {
                    return chain().setMark("textStyle", { fontWeight }).run();
                },

            unsetFontWeight:
                () =>
                ({ chain }) => {
                    return chain()
                        .setMark("textStyle", { fontWeight: null })
                        .removeEmptyTextStyle()
                        .run();
                },
        };
    },
});

// Available Space Grotesk font weights
export const FONT_WEIGHTS = [
    { value: "300", label: "Light", abbrev: "L", class: "space-grotesk-light" },
    {
        value: "400",
        label: "Regular",
        abbrev: "R",
        class: "space-grotesk-regular",
    },
    {
        value: "500",
        label: "Medium",
        abbrev: "M",
        class: "space-grotesk-medium",
    },
    {
        value: "600",
        label: "Semibold",
        abbrev: "SB",
        class: "space-grotesk-semibold",
    },
    { value: "700", label: "Bold", abbrev: "B", class: "space-grotesk-bold" },
];
