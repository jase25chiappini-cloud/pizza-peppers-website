export function getImagePath(imageName) {
    const formattedName = imageName.replace(/ /g, '-');
    return `/assets/pizzas/${formattedName}.jpg`;
}

export function formatId(name) {
    return name.toLowerCase().replace(/ & /g, '-and-').replace(/ /g, '-');
}