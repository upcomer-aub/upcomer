import { describe, expect, it } from "vitest";
import {
  cleanQuestionText, groupQuestions, isNearIdentical, LOW_CONFIDENCE_BELOW, matchQuestions, normalizeQuestionText, questionFeatures, rankGroups,
  REWORDED_THRESHOLD, type SourceQuestion,
} from "@/lib/question-grouping";

let nextId = 0;
const question = (fileId: string, text: string, extra: Partial<SourceQuestion> = {}): SourceQuestion =>
  ({ id: `q-${String(++nextId).padStart(3, "0")}`, fileId, number: nextId, text, year: null, ...extra });
const texts = (groups: { questions: SourceQuestion[] }[]) => groups.map(group => group.questions.map(item => item.text));

describe("normalizeQuestionText", () => {
  it.each([
    ["Explain the TCP three-way handshake.", "explain the tcp three-way handshake"],
    ["  EXPLAIN   the TCP\nthree-way handshake ", "explain the tcp three-way handshake"],
    ["Explain, the TCP three-way handshake!", "explain the tcp three-way handshake"],
    ["“Explain” the (TCP) three-way handshake?", "explain the tcp three-way handshake"],
  ])("ignores case, spacing, and punctuation in %j", (text, key) => expect(normalizeQuestionText(text)).toBe(key));
  it.each(["Q3. Define a socket.", "Question 3) Define a socket.", "3. Define a socket.", "3) Define a socket.", "(3) Define a socket.", "q12 Define a socket"])(
    "removes the question number in %j", text => expect(normalizeQuestionText(text)).toBe("define a socket"));
  it.each(["Define a socket. (10 points)", "Define a socket [5 marks]", "Define a socket (2.5 pts)"])(
    "removes marks in %j", text => expect(normalizeQuestionText(text)).toBe("define a socket"));
  it("keeps math symbols but ignores spacing around them", () => {
    expect(normalizeQuestionText("Compute x + y = 2")).toBe(normalizeQuestionText("compute x+y=2"));
    expect(normalizeQuestionText("Compute a + b")).not.toBe(normalizeQuestionText("Compute a - b"));
    expect(normalizeQuestionText("Find x^2")).not.toBe(normalizeQuestionText("Find x^3"));
  });
  it("keeps a number that starts the question itself", () => expect(normalizeQuestionText("2 + 2 = ?")).toBe("2+2="));
  it("shows the text without the number or marks but with its own case and punctuation", () => {
    expect(cleanQuestionText("Q1.  Explain the TCP handshake. (10 points)")).toBe("Explain the TCP handshake.");
  });
});

describe("isNearIdentical", () => {
  const near = (a: string, b: string) => isNearIdentical(normalizeQuestionText(a), normalizeQuestionText(b));
  it("accepts a one-letter typo or swap in a long word", () => {
    expect(near("How does a router recieve a packet?", "How does a router receive a packet?")).toBe(true);
    expect(near("Normalise the relation to 3NF.", "Normalize the relation to 3NF.")).toBe(true);
  });
  it("rejects different acronyms, numbers, and short words", () => {
    expect(near("Explain the TCP handshake.", "Explain the UDP handshake.")).toBe(false);
    expect(near("Find the derivative of x^2 at x = 3.", "Find the derivative of x^2 at x = 4.")).toBe(false);
    expect(near("Is the graph cyclic?", "Is the tree cyclic?")).toBe(false);
  });
  it("rejects real words one letter apart that start differently or are short", () => {
    expect(near("Describe the cable layer.", "Describe the table layer.")).toBe(false);
    expect(near("Show that the directed graph is cyclic.", "Show that the directed graph is acyclic.")).toBe(false);
    expect(near("Pop the stack.", "Pop the stuck.")).toBe(false);
  });
  it("rejects a different word even if it is close in spelling", () => {
    expect(near("Describe the insertion sort algorithm.", "Describe the selection sort algorithm.")).toBe(false);
  });
  it("rejects an extra or missing word", () => {
    expect(near("Explain the TCP handshake.", "Explain the full TCP handshake.")).toBe(false);
  });
  it("allows one typo per eight words and no more", () => {
    expect(near("Briefly explain how routers forward packets", "Brefly explain how ruoters forward packets")).toBe(false);
    const long = "Briefly explain how routers forward packets between networks using their routing tables and the longest prefix match rule";
    expect(near(long, long.replace("Briefly", "Brefly").replace("routers", "ruoters"))).toBe(true);
  });
});

describe("groupQuestions (US-15a)", () => {
  it("groups the same question from two papers that differ only in spacing, punctuation, or capitalisation", () => {
    const groups = groupQuestions([
      question("paper-a", "Explain the TCP three-way handshake."),
      question("paper-b", "explain   the tcp three-way handshake"),
      question("paper-c", "Q4) EXPLAIN THE TCP THREE-WAY HANDSHAKE?"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].questions.map(item => item.fileId)).toEqual(["paper-a", "paper-b", "paper-c"]);
  });
  it("keeps genuinely different questions in separate groups", () => {
    const groups = groupQuestions([
      question("paper-a", "Explain the TCP three-way handshake."),
      question("paper-b", "Explain the UDP header format."),
      question("paper-b", "Compute a + b"),
      question("paper-c", "Compute a - b"),
    ]);
    expect(groups).toHaveLength(4);
  });
  it("lists every source question and the paper each came from", () => {
    const sources = [question("paper-b", "Define a socket."), question("paper-a", "Define a socket"), question("paper-a", "Define a port.")];
    const groups = groupQuestions(sources);
    const socket = groups.find(group => group.normalizedText === "define a socket")!;
    expect(socket.questions.map(item => [item.id, item.fileId])).toEqual([[sources[1].id, "paper-a"], [sources[0].id, "paper-b"]]);
  });
  it("groups near-identical typos with the first version", () => {
    const groups = groupQuestions([question("paper-a", "How does a router receive a packet?"), question("paper-b", "How does a router recieve a packet?")]);
    expect(texts(groups)).toEqual([["How does a router receive a packet?", "How does a router recieve a packet?"]]);
    expect(groups[0].text).toBe("How does a router receive a packet?");
  });
  it("compares with each group's first question only, so typos cannot chain two different words together", () => {
    const groups = groupQuestions([
      question("paper-a", "Describe the protocol stack"),
      question("paper-b", "Describe the protocal stack"),
      question("paper-c", "Describe the protecal stack"),
    ]);
    expect(groups.map(group => group.questions.length)).toEqual([2, 1]);
  });
  it("skips a question with no text left after cleaning", () => {
    expect(groupQuestions([question("paper-a", "Q1."), question("paper-a", "  "), question("paper-a", "(10 points)")])).toEqual([]);
  });
  it("gives the same groups whatever order the questions come in", () => {
    const sources = [
      question("paper-b", "Define a socket"), question("paper-a", "Define a socket."), question("paper-c", "Explain ARP."),
      question("paper-a", "Explain arp"), question("paper-b", "What is a subnet mask?"),
    ];
    expect(groupQuestions([...sources].reverse())).toEqual(groupQuestions(sources));
  });
});

describe("matchQuestions (US-15b)", () => {
  it.each([
    ["Explain the TCP three-way handshake.", "Describe how TCP establishes a connection using the three-way handshake."],
    ["What is the difference between TCP and UDP?", "Compare TCP and UDP."],
    ["What does ARP do?", "What is the purpose of ARP?"],
    ["Define a socket.", "What is a socket?"],
    ["What's a deadlock?", "Define deadlock."],
    ["How does a router forward packets?", "Explain how packets are forwarded by a router."],
    ["List the advantages of virtual memory.", "What are the benefits of virtual memory?"],
    ["Describe the stages of the instruction pipeline.", "Explain the steps of the instruction pipeline."],
    ["Explain how ARP resolves an IP address to a MAC address.", "How does ARP resolve IP addresses into MAC addresses?"],
  ])("groups the same question worded differently: %j and %j", (a, b) => {
    expect(matchQuestions(a, b)).toMatchObject({ kind: "reworded" });
    expect(matchQuestions(b, a)).toEqual(matchQuestions(a, b));
  });
  it.each([
    ["Calculate the transmission delay of a 1500-byte packet on a 10 Mbps link.", "Find the transmission delay for a 1000 byte packet over a 100 Mbps link."],
    ["Convert 1011 from binary to decimal.", "Convert the binary number 1101 to decimal."],
  ])("groups the same exercise with different numbers: %j and %j", (a, b) => expect(matchQuestions(a, b)).toMatchObject({ kind: "reworded", score: 1 }));
  it.each([
    ["Explain the TCP three-way handshake.", "Explain the UDP three-way handshake."],
    ["What is the difference between TCP and UDP?", "What is the difference between TCP and IP?"],
    ["Explain IPv4 addressing.", "Explain IPv6 addressing."],
    ["Normalize the relation to 3NF.", "Normalize the relation to BCNF."],
    ["List the advantages of virtual memory.", "List the disadvantages of virtual memory."],
    ["Show that the directed graph is cyclic.", "Show that the directed graph is acyclic."],
    ["Describe a connection-oriented service.", "Describe a connectionless service."],
    ["Explain one's complement.", "Explain two's complement."],
    ["Explain how the insertion sort algorithm sorts an array of integers in ascending order", "Explain how the selection sort algorithm sorts an array of integers in ascending order"],
  ])("keeps a question with one content word swapped apart: %j and %j", (a, b) => expect(matchQuestions(a, b)).toBeNull());
  it.each([
    ["Explain the TCP three-way handshake.", "Explain TCP congestion control."],
    ["Explain ARP.", "Explain ARP spoofing."],
    ["Explain the sliding window protocol.", "Explain how ARP resolves an IP address to a MAC address."],
  ])("keeps same-topic but different questions apart: %j and %j", (a, b) => expect(matchQuestions(a, b)).toBeNull());
  it("keeps math expressions, negations, and a calculation against an explanation apart", () => {
    expect(matchQuestions("Compute x^3 + 1 for x = 3.", "Compute x^2 + 1 for x = 3.")).toBeNull();
    expect(matchQuestions("Find the derivative of x^2 at x = 3.", "Find the derivative of x^2 at x = 4.")).toBeNull();
    expect(matchQuestions("Which of the following is true about TCP?", "Which of the following is not true about TCP?")).toBeNull();
    expect(matchQuestions("Which statement about TCP isn't true?", "Which statement about TCP is not true?")).toMatchObject({ kind: "reworded" });
    expect(matchQuestions("Explain what affects the transmission delay of a link.", "Calculate the transmission delay of a link.")).toBeNull();
  });
  it("keeps a number that names what is asked about, such as a layer, an RFC, or a port", () => {
    expect(matchQuestions("Explain RFC 793.", "Explain RFC 791.")).toBeNull();
    expect(matchQuestions("Explain RFC 793.", "Describe RFC 793.")).toMatchObject({ kind: "reworded" });
    expect(matchQuestions("Explain the role of layer 3 in the OSI model.", "Explain the role of layer 4 in the OSI model.")).toBeNull();
    expect(matchQuestions("What runs on port 80?", "What runs on port 443?")).toBeNull();
    expect(matchQuestions("Question about topic number 5 in computer networks?", "Question about topic number 6 in computer networks?")).toBeNull();
    expect(matchQuestions("Describe the role of layer 3 in the OSI model.", "What is the purpose of layer 3 in the OSI model?")).toMatchObject({ kind: "reworded" });
  });
  it("allows other numbers to differ only in questions with enough words", () => {
    expect(matchQuestions("Sort 5 integers.", "Sort 7 integers.")).toBeNull();
    expect(matchQuestions("Sort 5 integers using merge sort.", "Using merge sort, sort 7 integers.")).toMatchObject({ kind: "reworded" });
  });
  it("reports identical and near-identical questions as such, and nothing for empty text", () => {
    expect(matchQuestions("Define a socket.", "define a SOCKET")).toEqual({ kind: "identical", score: 1 });
    expect(matchQuestions("How does a router recieve a packet?", "How does a router receive a packet?")).toEqual({ kind: "near_identical", score: 1 });
    expect(matchQuestions("Q1.", "Q1.")).toBeNull();
    expect(matchQuestions("What is it?", "What is this?")).toBeNull();
  });
  it("scores an added word below a full match, but at or above the threshold", () => {
    const added = matchQuestions("Explain the TCP three-way handshake.", "Describe how TCP establishes a connection using the three-way handshake.");
    expect(added!.score).toBeGreaterThanOrEqual(REWORDED_THRESHOLD);
    expect(added!.score).toBeLessThan(LOW_CONFIDENCE_BELOW);
  });
  it("folds plurals, synonyms, and contractions, and keeps math and numbers aside", () => {
    expect(questionFeatures("Q2. What are the differences between the queries? Compute x^2 for 10 values (5 marks)")).toEqual({
      words: ["compare", "query", "value"], numbers: ["10"], math: ["x^2"], negations: [], computes: true, explains: false,
    });
  });
});

describe("groupQuestions with reworded questions (US-15b)", () => {
  it("groups reworded questions with the first version and records the match", () => {
    const sources = [
      question("paper-a", "What is the difference between TCP and UDP?"),
      question("paper-b", "Compare TCP and UDP."),
      question("paper-c", "Compare TCP and UDP"),
      question("paper-c", "What is the difference between TCP and IP?"),
    ];
    const groups = groupQuestions(sources);
    expect(texts(groups)).toEqual([[sources[0].text, sources[1].text, sources[2].text], [sources[3].text]]);
    expect(groups[0].text).toBe("What is the difference between TCP and UDP?");
    // The third question joined through the second one's identical key, so only the second counts as a rewording.
    expect(groups[0].reworded).toEqual([{ questionId: sources[1].id, matchedQuestionId: sources[0].id, score: 1 }]);
    expect(groups[1].reworded).toEqual([]);
  });
  it("ranks a reworded question by every paper it appeared in", () => {
    const ranked = rankGroups(groupQuestions([
      question("paper-a", "Define a socket.", { year: 2023 }), question("paper-b", "What is a socket?", { year: 2024 }),
      question("paper-c", "Explain ARP.", { year: 2025 }),
    ]));
    expect(ranked.map(group => [group.text, group.paperCount, group.rank])).toEqual([["Define a socket.", 2, 1], ["Explain ARP.", 1, 2]]);
  });
  it("compares with the first question only, so rewordings cannot chain two different questions together", () => {
    const groups = groupQuestions([
      question("paper-a", "Explain ARP."),
      question("paper-b", "Explain ARP spoofing."),
      question("paper-c", "Explain ARP spoofing attacks."),
    ]);
    expect(groups.map(group => group.questions.length)).toEqual([1, 2]);
  });
  it("joins the best-matching group when several are close enough", () => {
    const first = "Explain the TCP three-way handshake.";
    const second = "Explain how TCP uses the three-way handshake to open and close connections.";
    const third = "Explain how TCP opens a connection with the three-way handshake.";
    expect(matchQuestions(first, second)).toBeNull();
    expect(matchQuestions(third, first)!.score).toBeLessThan(matchQuestions(third, second)!.score);
    const groups = groupQuestions([question("paper-a", first), question("paper-b", second), question("paper-c", third)]);
    expect(groups.map(group => group.questions.map(item => item.fileId))).toEqual([["paper-a"], ["paper-b", "paper-c"]]);
  });
  it("gives the same groups and matches whatever order the questions come in", () => {
    const sources = [
      question("paper-b", "Compare TCP and UDP."), question("paper-a", "What is the difference between TCP and UDP?"),
      question("paper-c", "What does ARP do?"), question("paper-a", "What is the purpose of ARP?"), question("paper-b", "Explain ARP spoofing."),
    ];
    expect(groupQuestions([...sources].reverse())).toEqual(groupQuestions(sources));
  });
});

describe("rankGroups (US-16)", () => {
  const sources = [
    question("paper-2023", "Define a socket.", { year: 2023 }),
    question("paper-2024", "Explain ARP.", { year: 2024 }),
    question("paper-2024", "Define a socket", { year: 2024 }),
    question("paper-2025", "Define a socket?", { year: 2025 }),
    question("paper-2025", "Explain ARP", { year: 2025 }),
    question("paper-2025", "What is a subnet mask?", { year: 2025 }),
    question("paper-2022", "What is NAT?", { year: 2022 }),
  ];

  it("puts groups that appeared in more papers first and numbers the ranks from 1", () => {
    const ranked = rankGroups(groupQuestions(sources));
    expect(ranked.map(group => [group.text, group.paperCount, group.rank])).toEqual([
      ["Define a socket.", 3, 1], ["Explain ARP.", 2, 2], ["What is a subnet mask?", 1, 3], ["What is NAT?", 1, 4],
    ]);
  });
  it("counts a question repeated inside the same paper once", () => {
    const ranked = rankGroups(groupQuestions([
      question("paper-a", "Define a socket."), question("paper-a", "Define a socket"), question("paper-a", "DEFINE A SOCKET"),
      question("paper-a", "Explain ARP."), question("paper-b", "Explain ARP."),
    ]));
    expect(ranked.map(group => [group.text, group.paperCount, group.questions.length])).toEqual([["Explain ARP.", 2, 2], ["Define a socket.", 1, 3]]);
  });
  it("reflects a newly processed paper when ranking runs again", () => {
    const before = rankGroups(groupQuestions(sources));
    expect(before.find(group => group.text === "What is NAT?")?.rank).toBe(4);
    const after = rankGroups(groupQuestions([
      ...sources, question("paper-2026a", "What is NAT", { year: 2026 }), question("paper-2026b", "what is nat?", { year: 2026 }),
      question("paper-2026c", "What is NAT?!", { year: 2026 }),
    ]));
    expect(after.map(group => group.text)).toEqual(["What is NAT?", "Define a socket.", "Explain ARP.", "What is a subnet mask?"]);
  });
  it("breaks ties by the most recent year, then by text, and papers without a year come last", () => {
    const ranked = rankGroups(groupQuestions([
      question("paper-x", "Beta question", { year: null }), question("paper-y", "Alpha question", { year: 2020 }),
      question("paper-z", "Gamma question", { year: 2020 }), question("paper-w", "Delta question", { year: 2024 }),
    ]));
    expect(ranked.map(group => group.text)).toEqual(["Delta question", "Alpha question", "Gamma question", "Beta question"]);
  });
  it("gives the identical order for the same input twice, in any input order", () => {
    const first = rankGroups(groupQuestions(sources));
    expect(rankGroups(groupQuestions(sources))).toEqual(first);
    expect(rankGroups(groupQuestions([...sources].reverse())).map(group => group.normalizedText)).toEqual(first.map(group => group.normalizedText));
  });
  it("returns nothing for a course without questions", () => expect(rankGroups(groupQuestions([]))).toEqual([]));
});
