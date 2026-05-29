import { test, expect } from "@playwright/test";

test.describe("todo fixture e2e", () => {
  test("adds a todo from the browser", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("todo-input").fill("Browser todo");
    await page.getByTestId("todo-add").click();
    await expect(page.getByTestId("todo-label")).toHaveText("Browser todo");
  });

  test("filters completed todos in the browser", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("todo-input").fill("Active");
    await page.getByTestId("todo-add").click();
    await page.getByTestId("todo-input").fill("Done");
    await page.getByTestId("todo-add").click();
    await page.getByTestId("todo-toggle").nth(1).check();
    await page.getByTestId("filter-completed").click();
    await expect(page.getByTestId("todo-item")).toHaveCount(1);
    await expect(page.getByTestId("todo-label")).toHaveText("Done");
  });

  test("persists completion after reload", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("todo-input").fill("Reload me");
    await page.getByTestId("todo-add").click();
    await page.getByTestId("todo-toggle").check();
    await page.reload();
    await expect(page.getByTestId("todo-item")).toHaveClass(/completed/);
  });
});
