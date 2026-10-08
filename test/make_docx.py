# -*- coding: utf-8 -*-
"""用标准库构造一个测试用 .docx（四级英语风格），验证 Word 上传链路。"""
import zipfile
from pathlib import Path

OUT = Path(__file__).parent / "四级英语模拟卷1.docx"

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def p(text, bold=False):
    rpr = '<w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/>%s</w:rPr>' % (
        "<w:b/>" if bold else "")
    return ('<w:p><w:r>%s<w:t xml:space="preserve">%s</w:t></w:r></w:p>'
            % (rpr, text))


paras = [
    p("大学英语四级模拟试卷（一）Part I Vocabulary", bold=True),
    p("Choose the best answer to each question."),
    p("1. The meeting was ______ until next week because of the storm."),
    p("A) canceled    B) postponed    C) denied    D) withdrew"),
    p("2. She has a great ______ for music — she plays three instruments."),
    p("A) talent    B) habit    C) trend    D) shade"),
    p("3. The manager asked him to ______ the report before Friday."),
    p("A) sum up    B) hand in    C) put off    D) get over"),
    p("4. Hardly had he arrived ______ the phone rang."),
    p("A) than    B) when    C) while    D) as"),
    p("5. It is high time that we ______ action to protect the environment."),
    p("A) take    B) took    C) will take    D) taking"),
    p("参考答案", bold=True),
    p("1. B。postpone 表示“推迟”，句意为会议因风暴被推迟到下周。"),
    p("2. A。have a talent for 为固定搭配，“在……方面有天赋”。"),
    p("3. B。hand in 意为“上交”。"),
    p("4. B。hardly...when... 为固定句型，“刚……就……”。"),
    p("5. B。It is high time that 后接过去式虚拟语气。"),
]

doc_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document %s><w:body>%s'
           '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
           '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
           '</w:sectPr></w:body></w:document>' % (W, "".join(paras)))

CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '</Types>')

RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CONTENT_TYPES)
    z.writestr("_rels/.rels", RELS)
    z.writestr("word/document.xml", doc_xml)

print("OK", OUT, OUT.stat().st_size, "bytes")
