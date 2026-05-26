import { Image as ImageIcon } from "lucide-react";
import { useRef, type ChangeEvent } from "react";

import type { NodeKind } from "../../../lib/diagram/types";
import { RibbonButton, RibbonGroup } from "./ribbonPrimitives";

export interface RibbonInsertProps {
  onInsert: (kind: NodeKind) => void;
  onImageFile: (event: ChangeEvent<HTMLInputElement>) => void;
}

const BASIC: NodeKind[] = ["simple", "text", "numbered", "section", "titled-box", "split-box"];
const SHAPES: NodeKind[] = ["diamond", "oval", "hexagon", "cylinder", "callout"];

const KIND_TO_KEY: Record<NodeKind, string> = {
  simple: "diagram.toolbar.addSimple",
  text: "diagram.toolbar.addText",
  section: "diagram.toolbar.addSection",
  numbered: "diagram.toolbar.addNumbered",
  "titled-box": "diagram.toolbar.addTitledBox",
  "split-box": "diagram.toolbar.addSplitBox",
  diamond: "diagram.toolbar.addDiamond",
  oval: "diagram.toolbar.addOval",
  hexagon: "diagram.toolbar.addHexagon",
  cylinder: "diagram.toolbar.addCylinder",
  callout: "diagram.toolbar.addCallout",
  table: "diagram.toolbar.addTable",
  image: "diagram.toolbar.addImage",
};

export function RibbonInsert({ onInsert, onImageFile }: RibbonInsertProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.basicNodes">
        {BASIC.map((kind) => (
          <RibbonButton key={kind} labelKey={KIND_TO_KEY[kind]} onClick={() => onInsert(kind)} />
        ))}
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.group.shapes">
        {SHAPES.map((kind) => (
          <RibbonButton key={kind} labelKey={KIND_TO_KEY[kind]} onClick={() => onInsert(kind)} />
        ))}
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.group.media">
        <RibbonButton labelKey={KIND_TO_KEY.table} onClick={() => onInsert("table")} />
        <RibbonButton
          labelKey={KIND_TO_KEY.image}
          onClick={() => fileRef.current?.click()}
          icon={<ImageIcon size={14} />}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onImageFile}
        />
      </RibbonGroup>
    </>
  );
}
