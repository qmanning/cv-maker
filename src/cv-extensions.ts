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
