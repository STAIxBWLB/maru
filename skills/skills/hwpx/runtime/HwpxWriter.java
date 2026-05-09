import kr.dogfoot.hwpxlib.object.HWPXFile;
import kr.dogfoot.hwpxlib.object.content.section_xml.SectionXMLFile;
import kr.dogfoot.hwpxlib.object.content.section_xml.paragraph.Para;
import kr.dogfoot.hwpxlib.object.content.section_xml.paragraph.Run;
import kr.dogfoot.hwpxlib.object.content.section_xml.paragraph.T;
import kr.dogfoot.hwpxlib.tool.blankfilemaker.BlankFileMaker;
import kr.dogfoot.hwpxlib.writer.HWPXWriter;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Tidy 문서 편집기용 최소 HWPX 생성기.
 * 사용: cat input.txt | java -cp "hwpxlib-1.0.5.jar:." HwpxWriter <output.hwpx>
 *
 * 입력 형식 (stdin, UTF-8, 한 줄에 한 단락):
 *   H1:대제목
 *   H2:중제목
 *   H3:소제목
 *   P:본문 단락
 *   P:(빈 줄)
 *
 * 표는 현재 MVP에서 미지원 — 본문 텍스트로만 변환.
 */
public class HwpxWriter {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Usage: HwpxWriter <output.hwpx>  (stdin = UTF-8 lines)");
            System.exit(1);
        }
        String outputPath = args[0];

        HWPXFile file = BlankFileMaker.make();
        SectionXMLFile section = file.sectionXMLFileList().get(0);

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        int count = 0;
        while ((line = reader.readLine()) != null) {
            addLine(section, line);
            count++;
        }
        if (count == 0) addParagraph(section, "");  // 최소 한 단락 보장

        HWPXWriter.toFilepath(file, outputPath);
        System.out.println("HWPX saved: " + outputPath + " (" + count + " paragraphs)");
    }

    private static void addLine(SectionXMLFile section, String raw) {
        String tag = "P";
        String text = raw;
        int colon = raw.indexOf(':');
        if (colon > 0 && colon <= 3) {
            String maybeTag = raw.substring(0, colon).trim();
            if (maybeTag.matches("H[1-6]|P")) {
                tag = maybeTag;
                text = raw.substring(colon + 1);
            }
        }
        addParagraph(section, text);
        // TODO: tag 에 따라 ParaShape/CharShape ID 변경 (제목 스타일)
    }

    private static void addParagraph(SectionXMLFile section, String text) {
        Para para = section.addNewPara();
        para.paraPrIDRef("0");
        para.styleIDRef("0");
        if (text == null || text.isEmpty()) return;
        Run run = para.addNewRun();
        run.charPrIDRef("0");
        T t = run.addNewT();
        t.addText(text);
    }
}
