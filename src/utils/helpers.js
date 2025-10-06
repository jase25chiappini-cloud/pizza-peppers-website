export function getImagePath(imageName) {
    // A small fix: handle names with spaces correctly for URLs
    const formattedName = imageName.replace(/ /g, '-');
    return `/assets/pizzas/${formattedName}.jpg`;
}

export function formatId(name) {
    return name.toLowerCase().replace(/ & /g, '-and-').replace(/ /g, '-');
}