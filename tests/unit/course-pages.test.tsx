import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getCourseById, getCourseExams, getCourseMaterials } = vi.hoisted(() => ({
  getCourseById: vi.fn(), getCourseExams: vi.fn(), getCourseMaterials: vi.fn(),
}));
vi.mock("@/lib/courses", () => ({ getCourseById, getCourseExams, getCourseMaterials }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
import CoursePage from "@/app/courses/[courseId]/page";
import ExamsPage from "@/app/courses/[courseId]/exams/page";
import MaterialsPage from "@/app/courses/[courseId]/materials/page";

const params = { params: Promise.resolve({ courseId: "course-a" }) };
const course = {
  id: "course-a", code: "EECE350", name: "Computer Networks", faculty: { name: "Faculty of Engineering" },
  professors: [{ professor: { name: "Professor A" } }],
};

beforeEach(() => {
  getCourseById.mockReset().mockResolvedValue(course);
  getCourseExams.mockReset().mockResolvedValue([]);
  getCourseMaterials.mockReset().mockResolvedValue([]);
});

describe("course pages", () => {
  it("shows course details and resource links", async () => {
    const html = renderToStaticMarkup(await CoursePage(params));
    expect(html).toContain("Computer Networks");
    expect(html).toContain("Faculty of Engineering");
    expect(html).toContain("Professor A");
    expect(html).toContain("/courses/course-a/exams");
    expect(html).toContain("/courses/course-a/materials");
    expect(html).toContain('href="/courses/course-a/practice/weak-topics">Practice your weak topics</a>');
  });
  it("handles a missing course", async () => {
    getCourseById.mockResolvedValue(null);
    await expect(CoursePage(params)).rejects.toThrow("not found");
  });
  it("shows exams and their empty state", async () => {
    getCourseExams.mockResolvedValueOnce([{ id: "exam-a", title: "Final Exam", professor: null, year: 2025, term: { name: "Fall" }, examType: "FINAL", topic: null }]);
    const html = renderToStaticMarkup(await ExamsPage(params));
    expect(html).toContain("Final Exam");
    expect(html).toContain("Term: Fall");
    expect(html).toContain("Type: Final");
    expect(renderToStaticMarkup(await ExamsPage(params))).toContain("No previous exams are available");
    expect(getCourseExams).toHaveBeenCalledWith("course-a");
  });
  it("shows materials and their empty state", async () => {
    getCourseMaterials.mockResolvedValueOnce([{ id: "material-a", title: "Network Models", professor: null, year: null, term: null, examType: null, topic: "Networking" }]);
    expect(renderToStaticMarkup(await MaterialsPage(params))).toContain("Network Models");
    expect(renderToStaticMarkup(await MaterialsPage(params))).toContain("No course materials are available");
    expect(getCourseMaterials).toHaveBeenCalledWith("course-a");
  });
});
