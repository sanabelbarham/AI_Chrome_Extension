document.addEventListener("input", (e) => {

    const element = e.target;

    if (
        element.tagName === "TEXTAREA" ||
        (element.tagName === "INPUT" &&
            element.type === "text")
    ) {

        console.log("User typed:", element.value);
    }
});