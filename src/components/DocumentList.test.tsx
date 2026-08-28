import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

describe("DocumentList boundary", () => {
  it("accepts only the four structural facade props", () => {
    const filePath = path.join(process.cwd(), "src/components/DocumentList.tsx");
    const source = ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
    let props: string[] = [];
    source.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== "DocumentListProps") return;
      props = node.members.flatMap((member) =>
        ts.isPropertySignature(member) && member.name ? [member.name.getText(source)] : [],
      );
    });

    expect(props).toEqual(["scope", "commands", "searchInputRef", "paneRef"]);
  });
});
