const button = document.getElementById("takeScreenshot");
const preview = document.getElementById("preview");

button.addEventListener("click", async () => {
  const screenshot = await chrome.tabs.captureVisibleTab(null, {
    format: "png",
  });

  preview.src = screenshot;
  preview.style.display = "block";
});
