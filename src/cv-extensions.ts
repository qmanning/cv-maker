// src/components/labs/icedcoffee/cv-extensions.ts
// IcedCoffee's TipTap additions. Font size / weight come from the shared extensions in
// components/ui; these cover what those don't: letter-spacing, paragraph line-height, column breaks.

import { Extension } from "@tiptap/core";
import "@tiptap/extension-text-style";

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        cvLetterSpacing: {
            setLetterSpacing: (value: string) => ReturnType;
            unsetLetterSpacing: () => ReturnType;
        };
        cvBlockLineHeight: {
            setBlockLineHeight: (value: string) => ReturnType;
            unsetBlockLineHeight: () => ReturnType;
        };
        cvColumnBreak: {
            toggleColumnBreak: () => ReturnType;
        };
    }
}

export const LetterSpacing = Extension.create({
    name: "cvLetterSpacing",

    addGlobalAttributes() {
        return [
            {
                types: ["textStyle"],
                attributes: {
                    letterSpacing: {
                        default: null,
                        parseHTML: (element) => element.style.letterSpacing || null,
                        renderHTML: (attributes) =>
                            attributes.letterSpacing
                                ? { style: `letter-spacing: ${attributes.letterSpacing}` }
                                : {},
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            setLetterSpacing:
                (letterSpacing) =>
                ({ chain }) =>
                    chain().setMark("textStyle", { letterSpacing }).run(),
            unsetLetterSpacing:
                () =>
                ({ chain }) =>
                    chain()
                        .setMark("textStyle", { letterSpacing: null })
                        .removeEmptyTextStyle()
                        .run(),
        };
    },
});

// line-height belongs to the paragraph (an inline span can only ever push a line taller)
export const BlockLineHeight = Extension.create({
    name: "cvBlockLineHeight",

    addGlobalAttributes() {
        return [
            {
                types: ["paragraph"],
                attributes: {
                    lineHeight: {
                        default: null,
                        parseHTML: (element) => element.style.lineHeight || null,
                        renderHTML: (attributes) =>
                            attributes.lineHeight
                                ? { style: `line-height: ${attributes.lineHeight}` }
                                : {},
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            setBlockLineHeight:
                (lineHeight) =>
                ({ commands }) =>
                    commands.updateAttributes("paragraph", { lineHeight }),
            unsetBlockLineHeight:
                () =>
                ({ commands }) =>
                    commands.resetAttributes("paragraph", "lineHeight"),
        };
    },
});

// "start the next column here" — on a bullet when the caret is in one, else on the paragraph
export const ColumnBreak = Extension.create({
    name: "cvColumnBreak",

    addGlobalAttributes() {
        return [
            {
                types: ["paragraph", "listItem"],
                attributes: {
                    colBreak: {
                        default: null,
                        parseHTML: (element) =>
                            element.hasAttribute("data-col-break") ? true : null,
                        renderHTML: (attributes) =>
                            attributes.colBreak ? { "data-col-break": "" } : {},
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            toggleColumnBreak:
                () =>
                ({ editor, commands }) => {
                    const type = editor.isActive("listItem") ? "listItem" : "paragraph";
                    const on = !!editor.getAttributes(type).colBreak;
                    return commands.updateAttributes(type, { colBreak: on ? null : true });
                },
        };
    },
});

// what an IMPORTED document's runs carry beyond size / weight / colour / spacing: a font per run (a Word résumé
// sets the name in one face and the body in another), a highlight, small caps written as capitals. Parsed from the
// span's own style and written back the same way, so a region keeps them through every edit.
const styleAttr = (prop: "fontFamily" | "backgroundColor" | "textTransform", css: string) => ({
    default: null,
    parseHTML: (element: HTMLElement) => element.style[prop] || null,
    renderHTML: (attributes: Record<string, string | null>) => (attributes[prop] ? { style: `${css}: ${attributes[prop]}` } : {}),
});
export const ImportedTextStyle = Extension.create({
    name: "cvImportedTextStyle",

    addGlobalAttributes() {
        return [
            {
                types: ["textStyle"],
                attributes: {
                    fontFamily: styleAttr("fontFamily", "font-family"),
                    backgroundColor: styleAttr("backgroundColor", "background-color"),
                    textTransform: styleAttr("textTransform", "text-transform"),
                },
            },
        ];
    },
});
